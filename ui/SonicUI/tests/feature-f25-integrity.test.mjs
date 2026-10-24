import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fingerprintEd25519PublicKey,
  verifyFileSha256,
  verifySignedManifest
} from '../src/main/download/integrityVerification.ts'

test('F-25 verifies user-provided SHA-256 and reports mismatch without calling it authentic', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sonic-integrity-'))
  try {
    const path = join(dir, 'sample.bin')
    const bytes = Buffer.from('trusted-by-comparison-not-by-source')
    await writeFile(path, bytes)
    const digest = createHash('sha256').update(bytes).digest('hex')
    assert.deepEqual(await verifyFileSha256(path, digest.toUpperCase()), {
      ok: true,
      algorithm: 'SHA-256',
      expected: digest,
      actual: digest,
      meaning: 'integrity-only'
    })
    assert.equal((await verifyFileSha256(path, '0'.repeat(64))).ok, false)
    await assert.rejects(() => verifyFileSha256(path, 'bad-hash'), /64-character SHA-256/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('F-25 validates Ed25519 signed manifests and exposes a key fingerprint for trust decisions', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const payload = JSON.stringify({ version: '2.6.1', url: 'https://example.invalid/update.exe' })
  const signature = sign(null, Buffer.from(payload), privateKey).toString('base64')
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const verified = verifySignedManifest({ payload, signature, keyId: 'release-key-1' }, pem)
  assert.equal(verified.valid, true)
  assert.equal(verified.payload, payload)
  assert.equal(verified.keyId, 'release-key-1')
  assert.match(verified.publicKeyFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(
    verifySignedManifest({ payload: payload + ' ', signature, keyId: 'release-key-1' }, pem).valid,
    false
  )
})

test('F-25 requires an independently pinned Ed25519 fingerprint before a signed manifest can be trusted', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const fingerprint = fingerprintEd25519PublicKey(pem)
  const payload = JSON.stringify({ publisher: 'test-publisher', version: '1.0.0' })
  const signature = sign(null, Buffer.from(payload), privateKey).toString('base64')
  const manifest = { payload, signature, keyId: 'release-key' }
  assert.match(fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(verifySignedManifest(manifest, pem).publicKeyFingerprint, fingerprint)
  assert.equal(verifySignedManifest(manifest, pem).valid, true)
  assert.notEqual(fingerprint, '0'.repeat(64))
  assert.equal(verifySignedManifest({ ...manifest, payload: payload + '!' }, pem).valid, false)
})
