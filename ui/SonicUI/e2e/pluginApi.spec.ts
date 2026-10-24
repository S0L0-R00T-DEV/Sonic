import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { expect, test } from './fixtures'
import {
  nameWithPlugin,
  pluginSigningPayload,
  resolvePluginHost,
  type SonicPluginManifest,
  validatePluginManifest
} from '../src/shared/pluginApi'
import { enabledDeclarativePlugin, verifyPluginManifest } from '../src/main/pluginTrust'

function makeSignedManifest(): {
  manifest: SonicPluginManifest
  publicKey: string
  privateKey: KeyObject
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const unsigned: Omit<SonicPluginManifest, 'signature'> = {
    id: 'example.download-helper',
    name: 'Example Download Helper',
    version: '1.0.0',
    apiVersion: 1,
    minAppVersion: '2.6.0',
    permissions: ['link.naming', 'host.resolution'],
    hooks: {
      filenameRules: [
        {
          host: 'downloads.example.test',
          pathPrefix: '/files/',
          template: '{host}-{basename}{extension}'
        }
      ],
      hostResolvers: [{ host: 'downloads.example.test', targetOrigin: 'https://cdn.example.test' }]
    }
  }
  const signature = sign(null, Buffer.from(pluginSigningPayload(unsigned)), privateKey).toString(
    'base64'
  )
  return {
    manifest: {
      ...unsigned,
      permissions: [...unsigned.permissions],
      signature: { algorithm: 'ed25519', keyId: 'trusted.example', value: signature }
    },
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey
  }
}

test('plugin manifests require a trusted Ed25519 signature and reject unsigned executable fields', () => {
  const { manifest, publicKey } = makeSignedManifest()
  expect(validatePluginManifest(manifest).valid).toBe(true)
  expect(verifyPluginManifest(manifest, { 'trusted.example': publicKey }, '2.6.0').valid).toBe(true)
  expect(
    verifyPluginManifest(manifest, { 'trusted.example': publicKey }, '2.5.9').errors.join(' ')
  ).toMatch(/requires app version 2.6.0 or later/i)
  expect(verifyPluginManifest(manifest, {}, '2.6.0').errors.join(' ')).toMatch(
    /not in the application's trusted-key registry/i
  )
  expect(
    verifyPluginManifest(
      { ...manifest, name: 'Tampered' },
      { 'trusted.example': publicKey },
      '2.6.0'
    ).errors.join(' ')
  ).toMatch(/signature verification failed/i)
  expect(
    validatePluginManifest({ ...manifest, entrypoint: './plugin.js' }).errors.join(' ')
  ).toMatch(/unknown manifest field/i)
})

test('plugin key rotation works with overlapping trust and revocation rejects the old signer', () => {
  const { manifest, publicKey: oldPublicKey } = makeSignedManifest()
  const { publicKey: newPublicKey, privateKey: newPrivateKey } = generateKeyPairSync('ed25519')
  const newPublicPem = newPublicKey.export({ type: 'spki', format: 'pem' }).toString()
  const trustedDuringRotation = {
    'trusted.example': oldPublicKey,
    'trusted.next': newPublicPem
  }

  expect(verifyPluginManifest(manifest, trustedDuringRotation, '2.6.0').valid).toBe(true)
  const { signature: omittedSignature, ...unsigned } = manifest
  void omittedSignature
  const rotatedManifest: SonicPluginManifest = {
    ...unsigned,
    signature: {
      algorithm: 'ed25519',
      keyId: 'trusted.next',
      value: sign(null, Buffer.from(pluginSigningPayload(unsigned)), newPrivateKey).toString(
        'base64'
      )
    }
  }
  expect(verifyPluginManifest(rotatedManifest, trustedDuringRotation, '2.6.0').valid).toBe(true)
  expect(verifyPluginManifest(manifest, { 'trusted.next': newPublicPem }, '2.6.0').valid).toBe(
    false
  )
})

test('declarative plugin hooks require explicit permissions and cannot cross their exact host match', () => {
  const { manifest } = makeSignedManifest()
  expect(enabledDeclarativePlugin(manifest, new Set(['example.download-helper:link.naming']))).toBe(
    false
  )
  expect(
    nameWithPlugin(manifest, 'https://downloads.example.test/files/archive.zip', 'archive.zip')
  ).toBe('downloads.example.test-archive.zip')
  expect(
    nameWithPlugin(manifest, 'https://other.example.test/files/archive.zip', 'archive.zip')
  ).toBeNull()
  expect(resolvePluginHost(manifest, 'https://downloads.example.test/files/archive.zip')).toBe(
    'https://cdn.example.test/files/archive.zip'
  )
  expect(
    resolvePluginHost(
      { ...manifest, permissions: ['link.naming'] },
      'https://downloads.example.test/files/archive.zip'
    )
  ).toBeNull()
})

test('plugin management IPC requires signature trust and explicit grants, persists state, and revokes safely', async ({
  sonic
}) => {
  const { manifest, publicKey, privateKey } = makeSignedManifest()
  await sonic.api.trustPluginKey('trusted.example', publicKey)

  const review = await sonic.api.reviewPluginManifest(JSON.stringify(manifest))
  expect(review.valid).toBe(true)
  const installed = await sonic.api.installPlugin(JSON.stringify(manifest))
  expect(installed.enabled).toBe(false)
  await expect(sonic.api.setPluginEnabled(manifest.id, true)).rejects.toThrow(
    /grant every requested permission/i
  )

  await sonic.api.setPluginPermissions(manifest.id, manifest.permissions)
  expect((await sonic.api.setPluginEnabled(manifest.id, true)).enabled).toBe(true)
  await sonic.relaunch()
  let registry = await sonic.api.listPlugins()
  expect(registry.trustedKeyIds).toContain('trusted.example')
  expect(registry.plugins.find((plugin) => plugin.id === manifest.id)?.enabled).toBe(true)

  const { signature: oldSignature, ...unsignedManifest } = manifest
  void oldSignature
  const newerUnsigned = { ...unsignedManifest, version: '1.1.0' }
  const newerManifest: SonicPluginManifest = {
    ...newerUnsigned,
    signature: {
      algorithm: 'ed25519',
      keyId: 'trusted.example',
      value: sign(null, Buffer.from(pluginSigningPayload(newerUnsigned)), privateKey).toString(
        'base64'
      )
    }
  }
  const updated = await sonic.api.installPlugin(JSON.stringify(newerManifest))
  expect(updated).toMatchObject({ version: '1.1.0', enabled: false, hasRollback: true })
  const rolledBack = await sonic.api.rollbackPlugin(manifest.id)
  expect(rolledBack).toMatchObject({ version: '1.0.0', enabled: false, hasRollback: false })

  await sonic.api.revokePluginKey('trusted.example')
  registry = await sonic.api.listPlugins()
  expect(registry.trustedKeyIds).not.toContain('trusted.example')
  expect(registry.plugins.find((plugin) => plugin.id === manifest.id)).toMatchObject({
    enabled: false,
    grantedPermissions: []
  })
})

test('plugin manifest rejects wildcard hosts, unsafe path prefixes and non-HTTPS host targets', () => {
  const { manifest } = makeSignedManifest()
  const invalid = {
    ...manifest,
    hooks: {
      filenameRules: [
        { host: '*.example.test', pathPrefix: '/files/', template: 'safe.zip' },
        { host: 'downloads.example.test', pathPrefix: '/../private', template: '../escape.zip' }
      ],
      hostResolvers: [
        { host: 'downloads.example.test', targetOrigin: 'http://cdn.example.test/path' },
        { host: 'downloads.example.test', targetOrigin: 'https://127.0.0.1' },
        { host: 'downloads.example.test', targetOrigin: 'https://localhost' }
      ]
    }
  }
  const result = validatePluginManifest(invalid)
  expect(result.valid).toBe(false)
  expect(result.errors.join(' ')).toMatch(/exact public hostname/i)
  expect(result.errors.join(' ')).toMatch(/path prefix/i)
  expect(result.errors.join(' ')).toMatch(/filename only/i)
  expect(result.errors.join(' ')).toMatch(/clean HTTPS origin/i)
})
