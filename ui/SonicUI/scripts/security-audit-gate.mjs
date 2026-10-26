import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (message) => {
  console.error(`[Sonic security gate] BLOCKED: ${message}`)
  process.exitCode = 1
}

let report
const audit =
  process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm audit --json'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024
      })
    : spawnSync('npm', ['audit', '--json'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024
      })
try {
  report = JSON.parse(audit.stdout)
} catch {
  fail(
    `npm audit did not return valid JSON (exit ${audit.status ?? 'unknown'}): ${audit.stderr || audit.stdout || audit.error || 'no output'}`
  )
}
if (!report) process.exit(1)
if (audit.error || (audit.status !== 0 && !report.vulnerabilities)) {
  fail(`npm audit could not complete: ${audit.stderr || audit.error || `exit ${audit.status}`}`)
  process.exit(1)
}

const vulnerabilities = report.vulnerabilities ?? {}
const knownExceptionPackages = new Set([
  'ip',
  'bittorrent-tracker',
  'torrent-discovery',
  'webtorrent',
  'braces',
  'micromatch',
  'find-yarn-workspace-root',
  'patch-package'
])
const unknown = Object.keys(vulnerabilities).filter((name) => !knownExceptionPackages.has(name))
if (unknown.length) {
  fail(`audit found unreviewed vulnerable packages: ${unknown.join(', ')}`)
  process.exit(1)
}
const expectedAdvisories = new Map([
  ['ip', 1101851],
  ['braces', 1240992]
])
for (const [name, source] of expectedAdvisories) {
  const vulnerability = vulnerabilities[name]
  if (!vulnerability) continue
  const advisorySources = (vulnerability.via ?? [])
    .filter((entry) => typeof entry === 'object' && entry !== null)
    .map((entry) => entry.source)
  if (advisorySources.length !== 1 || advisorySources[0] !== source) {
    fail(`${name} now has an unreviewed advisory set: ${JSON.stringify(advisorySources)}`)
    process.exit(1)
  }
}

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lockPackages = lock.packages ?? {}
const version = (name) => lockPackages[`node_modules/${name}`]?.version
let releaseBlocked = false
if (Object.keys(vulnerabilities).length) {
  if (version('webtorrent') !== '3.0.21' || version('ip') !== '2.0.1') {
    fail(
      `the reviewed torrent exception no longer matches the tested versions (webtorrent=${version('webtorrent')}, ip=${version('ip')})`
    )
    process.exit(1)
  }
  const reviewedBuildToolVersions = {
    braces: '3.0.3',
    micromatch: '4.0.8',
    'find-yarn-workspace-root': '2.0.0',
    'patch-package': '8.0.1'
  }
  for (const [name, expected] of Object.entries(reviewedBuildToolVersions)) {
    if (
      version(name) !== expected ||
      (name === 'patch-package' && packageJson.devDependencies?.[name] !== expected)
    ) {
      fail(
        `the reviewed build-tool exception changed: ${name} expected ${expected}, found ${version(name)}`
      )
      process.exit(1)
    }
  }
  const ipPatchPath = join(root, 'patches', 'ip+2.0.1.patch')
  const installedIpPath = join(root, 'node_modules', 'ip', 'lib', 'ip.js')
  if (!existsSync(ipPatchPath) || !existsSync(installedIpPath)) {
    fail('the reviewed ip@2.0.1 patch or installed package is missing')
    process.exit(1)
  }
  const patch = readFileSync(ipPatchPath, 'utf8')
  const installedIp = readFileSync(installedIpPath, 'utf8')
  if (
    !patch.includes('ipaddr.isValid(addr)') ||
    !patch.includes("parsed.range() !== 'unicast'") ||
    !installedIp.includes('ipaddr.isValid(addr)') ||
    !installedIp.includes("parsed.range() !== 'unicast'")
  ) {
    fail('the local ip@2.0.1 SSRF mitigation is missing or was not applied')
    process.exit(1)
  }
  const braceExpansionVersions = Object.entries(lockPackages)
    .filter(
      ([path]) =>
        path === 'node_modules/brace-expansion' || path.endsWith('/node_modules/brace-expansion')
    )
    .map(([, value]) => value.version)
    .filter((value) => String(value).startsWith('5.'))
  if (
    braceExpansionVersions.some((value) => {
      const [major, minor, patchNumber] = String(value).split('.').map(Number)
      return major < 5 || (major === 5 && (minor < 0 || (minor === 0 && patchNumber < 12)))
    })
  ) {
    fail(`brace-expansion 5.x must be at least 5.0.12; found ${braceExpansionVersions.join(', ')}`)
    process.exit(1)
  }

  const securityTests = spawnSync(
    process.execPath,
    ['--test', 'tests/ip-security.test.mjs', 'tests/security-hardening.test.mjs'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    }
  )
  if (securityTests.status !== 0) {
    fail(`security regression tests failed:\n${securityTests.stdout}\n${securityTests.stderr}`)
    process.exit(1)
  }

  console.log(
    `[Sonic security gate] Reviewed audit exceptions remain: ${Object.keys(vulnerabilities).join(', ')}`
  )
  console.log('[Sonic security gate] ip@2.0.1 mitigation and targeted security tests passed.')
  if (
    process.env['SONIC_REQUIRE_CODE_SIGNING'] === '1' &&
    !['CSC_LINK', 'WIN_CSC_LINK', 'CSC_NAME', 'WIN_CSC_NAME'].some((name) =>
      process.env[name]?.trim()
    )
  ) {
    fail(
      'Windows release packaging requires a configured trusted signing certificate (CSC_LINK/WIN_CSC_LINK or CSC_NAME/WIN_CSC_NAME).'
    )
    process.exit(1)
  }
  if (process.env['SONIC_ACCEPT_SECURITY_AUDIT_EXCEPTIONS'] !== '1') {
    fail(
      'release packaging is blocked while known npm audit exceptions remain. After explicit risk review, set SONIC_ACCEPT_SECURITY_AUDIT_EXCEPTIONS=1 for that release build; unknown vulnerabilities always block.'
    )
    releaseBlocked = true
  }
  if (process.env['SONIC_ACCEPT_SECURITY_AUDIT_EXCEPTIONS'] === '1') {
    console.warn(
      '[Sonic security gate] Explicit npm-audit exception acceptance supplied for this invocation; retain the audit report with the release.'
    )
  }
} else {
  console.log('[Sonic security gate] npm audit reports no vulnerabilities.')
}

const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
const missingLicenseTexts = (
  notices.match(
    /^- Local license\/notice file: not found; verify distribution obligations against the package publisher\.$/gm
  ) ?? []
).length
const unverifiedUpstreamLicenses = (
  notices.match(
    /^- License text provenance: (?:UPSTREAM BRANCH FILE; exact release correspondence requires owner verification\.|OWNER REVIEW REQUIRED:.*|CONFLICTING LICENSE METADATA:.*)$/gm
  ) ?? []
).length
const licenseIssues = missingLicenseTexts + unverifiedUpstreamLicenses
if (licenseIssues > 0 && process.env['SONIC_ACCEPT_UNVERIFIED_LICENSE_NOTICES'] !== '1') {
  fail(
    missingLicenseTexts +
      ' production dependency entries lack a bundled license file; ' +
      unverifiedUpstreamLicenses +
      ' license text entries have unverified provenance or conflicting metadata. Verify notices or document acceptance and set SONIC_ACCEPT_UNVERIFIED_LICENSE_NOTICES=1 for this release.'
  )
  releaseBlocked = true
}
if (licenseIssues > 0 && process.env['SONIC_ACCEPT_UNVERIFIED_LICENSE_NOTICES'] === '1') {
  console.warn(
    '[Sonic security gate] Explicitly accepted ' +
      licenseIssues +
      ' unresolved license/notice provenance entries; retain the review record with the release.'
  )
}
if (releaseBlocked) process.exit(1)
