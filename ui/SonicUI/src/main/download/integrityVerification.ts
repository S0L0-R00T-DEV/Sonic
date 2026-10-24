import { createHash, verify as verifySignature, createPublicKey } from 'node:crypto'
import { createReadStream } from 'node:fs'

export type IntegrityResult = {
  ok: boolean
  algorithm: 'SHA-256'
  expected: string
  actual: string
  meaning: 'integrity-only'
}

export async function verifyFileSha256(
  filePath: string,
  expectedHash: string
): Promise<IntegrityResult> {
  const expected = expectedHash
    .trim()
    .replace(/^(sha256:|sha-256:)/i, '')
    .toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('Enter a 64-character SHA-256 hex digest.')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  const actual = hash.digest('hex')
  return {
    ok: actual === expected,
    algorithm: 'SHA-256',
    expected,
    actual,
    meaning: 'integrity-only'
  }
}

export function fingerprintEd25519PublicKey(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Publisher key must be Ed25519.')
  return createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex')
}

export type SignedManifest = { payload: string; signature: string; keyId?: string }

/** Verify a detached Ed25519 signature over the exact UTF-8 payload. The caller must separately
 * establish trust in the public-key fingerprint; mathematical validity alone is not authenticity. */
export function verifySignedManifest(
  manifest: SignedManifest,
  publicKeyPem: string
): { valid: boolean; payload: string; keyId?: string; publicKeyFingerprint: string } {
  if (!manifest || typeof manifest.payload !== 'string' || typeof manifest.signature !== 'string')
    throw new Error('Manifest must contain string payload and signature fields.')
  const key = createPublicKey(publicKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Manifest key must be Ed25519.')
  const publicKeyFingerprint = fingerprintEd25519PublicKey(publicKeyPem)
  let signature: Buffer
  try {
    signature = Buffer.from(manifest.signature, 'base64')
  } catch {
    throw new Error('Invalid signature encoding.')
  }
  const valid = verifySignature(null, Buffer.from(manifest.payload, 'utf8'), key, signature)
  return {
    valid,
    payload: manifest.payload,
    ...(manifest.keyId ? { keyId: manifest.keyId } : {}),
    publicKeyFingerprint
  }
}
