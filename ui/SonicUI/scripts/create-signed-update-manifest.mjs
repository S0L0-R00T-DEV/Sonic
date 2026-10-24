import { createHash, createPrivateKey, sign } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

const [
  version,
  installerPath,
  platform = process.platform,
  outputPath = 'sonic-update-manifest.json'
] = process.argv.slice(2)
const privateKeyPem = process.env.SONIC_UPDATE_SIGNING_KEY_PEM
const keyId = process.env.SONIC_UPDATE_SIGNING_KEY_ID
if (!version || !installerPath || !['win32', 'darwin', 'linux'].includes(platform)) {
  console.error(
    'Usage: node scripts/create-signed-update-manifest.mjs <version> <installer-path> [win32|darwin|linux] [output-path]'
  )
  process.exit(2)
}
if (!privateKeyPem) {
  console.error('SONIC_UPDATE_SIGNING_KEY_PEM must be supplied from a protected release secret.')
  process.exit(2)
}
const privateKey = createPrivateKey(privateKeyPem)
if (privateKey.asymmetricKeyType !== 'ed25519')
  throw new Error('Release signing key must be Ed25519.')
const hash = createHash('sha256')
for await (const chunk of createReadStream(installerPath)) hash.update(chunk)
const payload = JSON.stringify({
  version: version.replace(/^v/i, ''),
  assetName: basename(installerPath),
  sha256: hash.digest('hex'),
  platform
})
const signature = sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64')
const output = JSON.stringify({ payload, signature, ...(keyId ? { keyId } : {}) }, null, 2) + '\n'
await writeFile(outputPath, output, { flag: 'w', mode: 0o600 })
console.log(
  `Created signed update manifest for ${basename(installerPath)} (${platform}); private key was not written to disk.`
)
