import test from 'node:test'
import assert from 'node:assert/strict'
import ip from 'ip'

test('ip public-address checks fail closed for ambiguous loopback and local ranges', () => {
  // Regression cases from GHSA-2p57-rm9w-gvfp / CVE-2024-29415 include alternate
  // IPv4 numeric forms and non-canonical IPv6 spellings that must not bypass SSRF guards.
  for (const address of [
    '017700000001',
    '01200034567',
    '127.1',
    '012.1.2.3',
    '127.0.0.1',
    '10.0.0.1',
    '169.254.1.1',
    '::1',
    '000:0:0000::01',
    '::ffff:127.0.0.1',
    '::fFFf:127.0.0.1',
    'not-an-ip'
  ]) {
    assert.equal(ip.isPublic(address), false, `${address} must not be treated as public`)
    assert.equal(ip.isPrivate(address), true, `${address} must fail closed as private/non-public`)
  }
})

test('ip public-address checks preserve known public unicast addresses', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']) {
    assert.equal(ip.isPublic(address), true, `${address} should remain public`)
    assert.equal(ip.isPrivate(address), false, `${address} should not be classified private`)
  }
})
