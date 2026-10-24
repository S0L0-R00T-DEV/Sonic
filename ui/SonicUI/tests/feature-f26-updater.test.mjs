import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNewerVersion, parseVerifiedAssetPayload } from '../src/main/updaterVersion.ts'

test('F-26 compares stable release versions numerically', () => {
  assert.equal(isNewerVersion('v2.7.0', '2.6.9'), true)
  assert.equal(isNewerVersion('2.6.0', '2.6.0'), false)
  assert.equal(isNewerVersion('2.5.99', '2.6.0'), false)
  assert.equal(isNewerVersion('not-a-version', '2.6.0'), false)
})

test('F-26 accepts only release-matched, platform-matched signed asset metadata', () => {
  const assets = [
    {
      name: 'Sonic-setup.exe',
      browser_download_url:
        'https://github.com/example/sonic/releases/download/v2.7.0/Sonic-setup.exe',
      size: 2048
    }
  ]
  const payload = JSON.stringify({
    version: '2.7.0',
    assetName: 'Sonic-setup.exe',
    sha256: 'a'.repeat(64),
    platform: 'win32'
  })
  assert.deepEqual(parseVerifiedAssetPayload(payload, 'v2.7.0', assets, 'win32'), {
    version: '2.7.0',
    assetName: 'Sonic-setup.exe',
    sha256: 'a'.repeat(64),
    platform: 'win32'
  })
  assert.throws(
    () => parseVerifiedAssetPayload(payload, '2.8.0', assets, 'win32'),
    /version does not match/
  )
  assert.throws(
    () => parseVerifiedAssetPayload(payload, '2.7.0', assets, 'linux'),
    /explicitly target this operating system/
  )
  assert.throws(
    () =>
      parseVerifiedAssetPayload(
        JSON.stringify({ version: '2.7.0', assetName: 'Sonic-setup.exe', sha256: 'a'.repeat(64) }),
        '2.7.0',
        assets,
        'win32'
      ),
    /must explicitly target/
  )
  assert.throws(
    () =>
      parseVerifiedAssetPayload(
        JSON.stringify({
          version: '2.7.0',
          assetName: '../setup.exe',
          sha256: 'a'.repeat(64),
          platform: 'win32'
        }),
        '2.7.0',
        assets,
        'win32'
      ),
    /invalid asset name/
  )
  assert.throws(
    () =>
      parseVerifiedAssetPayload(
        JSON.stringify({
          version: '2.7.0',
          assetName: 'Sonic-setup.exe',
          sha256: 'a'.repeat(64),
          platform: 'win32'
        }),
        '2.7.0',
        [{ ...assets[0], browser_download_url: 'http://untrusted.invalid/setup.exe' }],
        'win32'
      ),
    /not present as a GitHub-hosted/
  )
})
