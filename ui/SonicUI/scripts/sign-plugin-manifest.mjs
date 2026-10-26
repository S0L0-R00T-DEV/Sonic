#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { readFile, writeFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

function argumentsFrom(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!['--input', '--output', '--key', '--key-id'].includes(arg)) {
      throw new Error('Usage: node scripts/sign-plugin-manifest.mjs --input unsigned.json --output signed.json --key <private-key.pem outside repo> --key-id <trusted-key-id>')
    }
    const value = argv[++index]
    if (!value) throw new Error('Missing value for ' + arg)
    values[arg] = value
  }
  for (const key of ['--input', '--output', '--key', '--key-id']) {
    if (!values[key]) throw new Error('Missing required argument ' + key)
  }
  return values
}

function signingPayload(manifest) {
  return JSON.stringify({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    minAppVersion: manifest.minAppVersion,
    permissions: [...manifest.permissions].sort(),
    hooks: {
      filenameRules: manifest.hooks.filenameRules ?? [],
      hostResolvers: manifest.hooks.hostResolvers ?? [],
      integrations: manifest.hooks.integrations ?? []
    }
  })
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2))
  const projectRoot = await realpath(resolve(fileURLToPath(new URL('..', import.meta.url))))
  const keyPath = resolve(args['--key'])
  const keyRelative = relative(projectRoot, keyPath)
  if (keyRelative === '' || (!keyRelative.startsWith('..' + sep) && keyRelative !== '..' && !isAbsolute(keyRelative))) {
    throw new Error('Refusing to read a private signing key from inside the Sonic repository. Keep it in external, access-controlled storage.')
  }
  const privateKey = createPrivateKey(await readFile(keyPath))
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Plugin signing requires an Ed25519 private key.')
  }
  const input = JSON.parse(await readFile(resolve(args['--input']), 'utf8'))
  if (!input || typeof input !== 'object' || Array.isArray(input) || !input.hooks || !Array.isArray(input.permissions)) {
    throw new Error('Input must be an unsigned Sonic plugin manifest JSON object.')
  }
  const { signature: ignored, ...unsigned } = input
  void ignored
  const payload = signingPayload(unsigned)
  const signature = sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64')
  const signed = {
    ...unsigned,
    signature: {
      algorithm: 'ed25519',
      keyId: args['--key-id'],
      value: signature
    }
  }
  const publicKey = createPublicKey(privateKey)
  const fingerprint = createHash('sha256')
    .update(publicKey.export({ format: 'der', type: 'spki' }))
    .digest('hex')
  await writeFile(resolve(args['--output']), JSON.stringify(signed, null, 2) + '\n', 'utf8')
  process.stdout.write('Signed manifest written.\n')
  process.stdout.write('Key ID: ' + args['--key-id'] + '\n')
  process.stdout.write('Public-key SPKI SHA-256: ' + fingerprint + '\n')
  process.stdout.write('Keep the private key outside the repository and never distribute it.\n')
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 1
})
