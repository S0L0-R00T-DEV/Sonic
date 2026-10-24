import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JavaScript test file
const read = (path) => readFileSync(join(root, path), 'utf8')

test('browser extension avoids the broad tabs permission in source and built packages', () => {
  for (const path of [
    'extension/manifest.json',
    'extension/dist/chrome/manifest.json',
    'extension/dist/firefox/manifest.json'
  ]) {
    const manifest = JSON.parse(read(path))
    assert.ok(manifest.permissions.includes('activeTab'), `${path} must use activeTab`)
    assert.equal(manifest.permissions.includes('tabs'), false, `${path} must not request tabs`)
    assert.deepEqual(manifest.host_permissions, ['<all_urls>'])
  }
})

test('CLI control accepts one command per connection and caps concurrent clients', () => {
  const source = read('src/main/cliControl.ts')
  assert.match(source, /if \(answered \|\| handling\) return/)
  assert.match(source, /handling = true[\s\S]*?void dispatch\(request as CliRequest\)/)
  assert.match(source, /instance\.maxConnections = 32/)
  assert.match(source, /input\.length > 1_000_000/)
})

test('network probes reject unsupported schemes, including redirect targets', () => {
  const source = read('src/main/download/probe.ts')
  assert.match(source, /function assertHttpProtocol\(url: URL\)/)
  assert.match(source, /let current = new URL\(rawUrl\)\s+assertHttpProtocol\(current\)/)
  assert.match(
    source,
    /current = new URL\(location, current\)[\s\S]*?assertHttpProtocol\(current\)/
  )
})

test('browser bridge bounds socket, probe, and pending-handoff resource use', () => {
  const source = read('src/main/browserBridge.ts')
  assert.match(source, /server\.maxConnections = 32/)
  assert.match(source, /server\.requestTimeout = 15_000/)
  assert.match(source, /const MAX_ACTIVE_PROBES = 4/)
  assert.match(source, /if \(activeProbes >= MAX_ACTIVE_PROBES\)/)
  assert.match(source, /const MAX_PENDING_HANDOFFS = 128/)
  assert.match(source, /handoffs\.size >= MAX_PENDING_HANDOFFS/)
})

test('Unix CLI sockets are owner-only and fail closed if permissions cannot be applied', () => {
  const source = read('src/main/cliControl.ts')
  assert.match(source, /chmod\(endpoint, 0o600\)/)
  assert.match(source, /could not secure the local socket; closing it/)
  assert.match(source, /instance\.maxConnections = 32/)
  assert.match(source, /input\.length > 1_000_000/)
})

test('release packaging runs the audit gate and blocks unsigned Windows releases', () => {
  const packageJson = JSON.parse(read('package.json'))
  assert.match(packageJson.scripts['prebuild:win'], /SONIC_REQUIRE_CODE_SIGNING=1/)
  assert.match(packageJson.scripts['prebuild:win'], /security:gate/)
  assert.match(packageJson.scripts['prebuild:mac'], /security:gate/)
  assert.match(packageJson.scripts['prebuild:linux'], /security:gate/)
  const gate = read('scripts/security-audit-gate.mjs')
  assert.match(gate, /unreviewed vulnerable packages/)
  assert.match(gate, /SONIC_ACCEPT_SECURITY_AUDIT_EXCEPTIONS/)
  assert.match(gate, /requires a configured trusted signing certificate/)
  assert.match(gate, /SONIC_ACCEPT_UNVERIFIED_LICENSE_NOTICES/)
})
