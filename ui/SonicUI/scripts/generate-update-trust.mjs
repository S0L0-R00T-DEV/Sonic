import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const privateKeyPem = process.env.SONIC_UPDATE_SIGNING_KEY_PEM
if (!privateKeyPem) {
  throw new Error('SONIC_UPDATE_SIGNING_KEY_PEM must be supplied from a protected release secret.')
}
const privateKey = createPrivateKey(privateKeyPem)
if (privateKey.asymmetricKeyType !== 'ed25519') {
  throw new Error('Update signing key must be Ed25519.')
}
const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
const fingerprint = createHash('sha256')
  .update(createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }))
  .digest('hex')
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = join(root, 'src', 'main', 'updateTrust.generated.ts')
const source = [
  '// Generated during the signed release build. Do not edit by hand.',
  `export const UPDATE_PUBLISHER_PUBLIC_KEY_PEM = ${JSON.stringify(publicKeyPem)}`,
  `export const UPDATE_PUBLISHER_KEY_FINGERPRINT = ${JSON.stringify(fingerprint)}`,
  ''
].join('\n')
await writeFile(output, source, { encoding: 'utf8' })
console.log(`Pinned update publisher key (${fingerprint.slice(0, 12)}…) into the release build.`)
