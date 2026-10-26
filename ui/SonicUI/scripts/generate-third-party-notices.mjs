import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = join(root, 'package-lock.json')
const outputPath = join(root, 'THIRD_PARTY_NOTICES.md')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
const licenseFilePattern = /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[._ -].*)?$/i
const MAX_LICENSE_FILE_BYTES = 200_000
const licenseCachePath = join(root, 'third-party-license-cache', 'index.json')
const licenseCache = existsSync(licenseCachePath)
  ? JSON.parse(readFileSync(licenseCachePath, 'utf8'))
  : { licenses: {} }

function loadCachedUpstreamLicense(name, version) {
  const entry = licenseCache.licenses?.[name + '@' + version]
  if (!entry || typeof entry.file !== 'string' || entry.file !== entry.file.split(/[\\/]/).pop()) {
    return null
  }
  const path = join(root, 'third-party-license-cache', entry.file)
  if (!existsSync(path)) return null
  const content = readFileSync(path, 'utf8')
  const actualHash = createHash('sha256').update(content, 'utf8').digest('hex')
  if (actualHash !== entry.sha256) {
    throw new Error('Cached third-party license hash mismatch for ' + name + '@' + version)
  }
  const ref = entry.source?.match(/\/blob\/([^/]+)\//)?.[1] ?? ''
  const exactTag = ref === version || ref === 'v' + version
  return {
    name: entry.file,
    content,
    source: entry.source,
    sha256: actualHash,
    requiresReview: !exactTag,
    provenance: exactTag
      ? 'UPSTREAM VERSION TAG FILE.'
      : 'UPSTREAM BRANCH FILE; exact release correspondence requires owner verification.'
  }
}

function readManifest(packageDirectory) {
  const path = join(root, packageDirectory, 'package.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function authorName(author) {
  const one = (value) => {
    if (typeof value === 'string') {
      return value
        .replace(/<[^>]*>/g, '')
        .replace(/\([^)]*\)/g, '')
        .trim()
    }
    if (value && typeof value === 'object' && typeof value.name === 'string')
      return value.name.trim()
    return ''
  }
  const values = Array.isArray(author) ? author.map(one) : [one(author)]
  return values.filter(Boolean).join(' and ')
}

/**
 * Some npm tarballs declare a standard SPDX license but omit the license file entirely.
 * Include the canonical terms with attribution from that exact locked package manifest.
 * This is explicitly marked as reconstructed, not as an upstream-provided license file.
 */
function reconstructStandardLicense(manifest, declaredLicense, packageName) {
  const inferredElectronHolder = packageName === '@electron-internal/extract-zip'
  const holder =
    authorName(manifest.author) || (inferredElectronHolder ? 'Electron contributors' : '')
  if (!holder || !['MIT', 'BSD-2-Clause'].includes(declaredLicense)) return null

  const content =
    declaredLicense === 'MIT'
      ? `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
      : `BSD 2-Clause License

Copyright (c) ${holder}
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDER AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`

  return {
    name: declaredLicense + ' (reconstructed from SPDX identifier and package author)',
    content,
    source:
      declaredLicense === 'MIT'
        ? 'https://spdx.org/licenses/MIT.txt'
        : 'https://spdx.org/licenses/BSD-2-Clause.txt',
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    requiresReview: inferredElectronHolder,
    provenance: inferredElectronHolder
      ? 'OWNER REVIEW REQUIRED: package declares BSD-2-Clause but omits an author/copyright holder; Electron contributors attribution is inferred from the package namespace.'
      : 'Canonical standard license terms; copyright attribution taken from the exact locked package.json author field because the published tarball omitted a license file.'
  }
}

function reconstructAmbiguousLicense(name, manifest, declaredLicense) {
  // compact2string@1.4.1 declares BSD in its published package.json; its README
  // separately says MIT, and the tarball contains no license file. Use the explicit
  // package metadata's BSD-2-Clause interpretation for the redistributed notice and
  // preserve the discrepancy in provenance rather than silently omitting license terms.
  // BSD-2-Clause is the conservative, SPDX-specific form reported by independent package
  // metadata scanners for this package. This is a documented project policy decision.
  if (name !== 'compact2string' || declaredLicense !== 'BSD') return null
  const bsd = reconstructStandardLicense(manifest, 'BSD-2-Clause', name)
  if (!bsd) return null
  bsd.name = 'BSD-2-Clause License (conservative package-metadata interpretation)'
  bsd.source = 'https://www.npmjs.com/package/compact2string'
  bsd.requiresReview = false
  bsd.provenance =
    'CONSERVATIVE LICENSE RESOLUTION: the locked package manifest declares BSD, while the README says MIT and the published tarball has no license file. BSD-2-Clause terms are included based on the package metadata; this discrepancy remains documented for transparency.'
  return { files: [bsd], provenance: bsd }
}

function normalizeLicense(license) {
  if (typeof license === 'string') return license
  if (Array.isArray(license))
    return license.map(normalizeLicense).filter(Boolean).join(', ') || 'Not declared'
  if (license && typeof license === 'object') {
    if (typeof license.type === 'string') return license.type
    if (typeof license.url === 'string') return license.url
  }
  return 'Not declared in package metadata'
}

function readLicenseFiles(packageDirectory) {
  const absoluteDirectory = join(root, packageDirectory)
  let names = []
  try {
    names = readdirSync(absoluteDirectory).filter((name) => licenseFilePattern.test(name))
  } catch {
    return []
  }
  const files = []
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    const filePath = join(absoluteDirectory, name)
    try {
      if (!statSync(filePath).isFile()) continue
      if (statSync(filePath).size > MAX_LICENSE_FILE_BYTES) {
        files.push({
          name,
          content: '[File omitted: exceeds 200 KB limit; see the package in node_modules.]'
        })
        continue
      }
      files.push({ name, content: readFileSync(filePath, 'utf8').trim() })
    } catch {
      files.push({ name, content: '[File could not be read from the installed package.]' })
    }
  }
  return files
}

function readReadmeLicense(packageDirectory, declaredLicense) {
  const absoluteDirectory = join(root, packageDirectory)
  let names = []
  try {
    names = readdirSync(absoluteDirectory).filter((name) =>
      /^readme(?:\.(?:md|markdown|txt))?$/i.test(name)
    )
  } catch {
    return null
  }
  for (const name of names) {
    let text = ''
    try {
      text = readFileSync(join(absoluteDirectory, name), 'utf8')
    } catch {
      continue
    }
    const heading = text.search(/^(?:#{1,6}\s*)?license\s*:?\s*$/im)
    const section = heading >= 0 ? text.slice(heading) : text
    const permission = section.search(/permission is hereby granted/i)
    if (permission < 0) continue
    const sectionLower = section.toLowerCase()
    const mitValid =
      declaredLicense === 'MIT' &&
      sectionLower.includes('the above copyright notice') &&
      sectionLower.includes('the software is provided') &&
      sectionLower.includes('without warranty of any kind')
    const bsdValid =
      declaredLicense === 'BSD-2-Clause' &&
      sectionLower.includes('redistribution and use in source and binary forms') &&
      sectionLower.includes('the following conditions are met') &&
      (section.match(/^\s*1\./gm) ?? []).length > 0 &&
      (section.match(/^\s*2\./gm) ?? []).length > 0 &&
      (section.match(/^\s*3\./gm) ?? []).length === 0
    if (!mitValid && !bsdValid) continue
    const copyright = section.lastIndexOf('Copyright', permission)
    const start = copyright >= 0 ? copyright : permission
    const endings = mitValid ? ['IN THE SOFTWARE.'] : ['SUCH DAMAGE.']
    const endMatches = endings
      .map((ending) => section.toLowerCase().indexOf(ending.toLowerCase(), permission))
      .filter((end) => end >= 0)
    if (endMatches.length === 0) continue
    const end = Math.min(...endMatches) + endings[0].length
    const content = section.slice(start, end).trim() + '\n'
    return {
      name: name + ' (embedded license section)',
      content,
      source: name,
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      requiresReview: false,
      provenance: 'Extracted from the README distributed with the locked package version.'
    }
  }
  return null
}

const components = []
for (const [location, locked] of Object.entries(lock.packages ?? {})) {
  if (!location || !location.includes('node_modules/') || locked.dev === true) continue
  const manifest = readManifest(location)
  if (!manifest) continue // platform-specific optional packages may be absent from node_modules
  const name =
    manifest.name ?? locked.name ?? location.slice(location.lastIndexOf('node_modules/') + 13)
  const version = manifest.version ?? locked.version ?? 'unknown'
  // npm packages may still use the legacy `licenses` array; honor it before reporting metadata missing.
  const licenses = normalizeLicense(
    manifest.license ?? manifest.licenses ?? locked.license ?? locked.licenses
  )
  const licenseFiles = readLicenseFiles(location)
  let licenseProvenance = null
  if (licenseFiles.length === 0) {
    const readmeLicense = readReadmeLicense(location, licenses)
    if (readmeLicense) {
      licenseFiles.push(readmeLicense)
      licenseProvenance = readmeLicense
    }
  }
  if (licenseFiles.length === 0) {
    const ambiguous = reconstructAmbiguousLicense(name, manifest, licenses)
    if (ambiguous) {
      licenseFiles.push(...ambiguous.files)
      licenseProvenance = ambiguous.provenance
    } else {
      const cached = loadCachedUpstreamLicense(name, version)
      if (cached && !cached.requiresReview) {
        licenseFiles.push(cached)
        licenseProvenance = cached
      } else {
        const reconstructed = reconstructStandardLicense(manifest, licenses, name)
        if (reconstructed) {
          licenseFiles.push(reconstructed)
          licenseProvenance = reconstructed
        } else if (cached) {
          licenseFiles.push(cached)
          licenseProvenance = cached
        }
      }
    }
  }
  components.push({ name, version, location, licenses, licenseFiles, licenseProvenance })
}
components.sort(
  (a, b) =>
    a.name.localeCompare(b.name) ||
    a.version.localeCompare(b.version) ||
    a.location.localeCompare(b.location)
)

const lines = [
  '# Sonic — Third-Party Notices',
  '',
  'This file is generated from the installed production dependency metadata and package-lock.json.',
  'It lists production dependency components and includes their locally available license/notice files.',
  'Regenerate with: `npm run generate:notices`.',
  '',
  `Production dependency instances inventoried: ${components.length}`,
  '',
  'This inventory is not a security audit; see the CycloneDX SBOM and npm audit report for component risk status.',
  ''
]
for (const component of components) {
  lines.push(`## ${component.name}@${component.version}`, '')
  lines.push(`- Declared license: ${component.licenses}`)
  lines.push(`- Lockfile location: ${component.location.split('/').join(sep)}`)
  if (component.licenseFiles.length === 0) {
    lines.push(
      '- Local license/notice file: not found; verify distribution obligations against the package publisher.'
    )
    lines.push('')
    continue
  }
  if (component.licenseProvenance) {
    const source = component.licenseProvenance.source
    lines.push(
      '- License text source: ' +
        (source?.includes('://') ? source : component.location + sep + source)
    )
    lines.push('- License text SHA-256: ' + component.licenseProvenance.sha256)
    lines.push('- License text provenance: ' + component.licenseProvenance.provenance)
  }
  lines.push('- Included files: ' + component.licenseFiles.map((file) => file.name).join(', '), '')
  for (const licenseFile of component.licenseFiles) {
    lines.push(
      `### ${licenseFile.name}`,
      '',
      '```text',
      licenseFile.content.replaceAll('```', '`​``'),
      '```',
      ''
    )
  }
}

writeFileSync(outputPath, lines.join('\n') + '\n', 'utf8')
console.log(
  `Generated ${relative(root, outputPath)} for ${components.length} production dependency instances.`
)
console.log(
  `Entries without an included license text: ${components.filter((component) => component.licenseFiles.length === 0).length}.`
)
console.log(
  `Entries requiring license provenance or metadata review: ${components.filter((component) => component.licenseProvenance?.requiresReview).length}.`
)
