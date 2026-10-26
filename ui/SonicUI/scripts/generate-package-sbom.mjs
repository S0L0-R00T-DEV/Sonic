import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const projectRoot = join(dirname(scriptPath), '..')
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(projectRoot, 'package-lock.json'), 'utf8'))
const productName = "Speed-o'-Freq Sonic"

function parseNpmSbom() {
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm'
  const args =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm sbom --omit=dev --sbom-format=cyclonedx']
      : ['sbom', '--omit=dev', '--sbom-format=cyclonedx']
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.error || result.status !== 0) {
    throw new Error('npm sbom failed: ' + (result.stderr || result.error?.message || result.status))
  }
  const start = result.stdout.indexOf('{')
  const end = result.stdout.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('npm sbom did not emit JSON.')
  const bom = JSON.parse(result.stdout.slice(start, end + 1))
  if (bom.bomFormat !== 'CycloneDX' || !Array.isArray(bom.components)) {
    throw new Error('npm sbom did not emit a CycloneDX component list.')
  }
  return bom
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
function walkFiles(dir) {
  if (!existsSync(dir)) return []
  const results = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) results.push(...walkFiles(full))
    else if (entry.isFile()) results.push(full)
  }
  return results
}
function componentRef(component) {
  return (
    component['bom-ref'] ||
    component.purl ||
    component.name + '@' + (component.version || 'unknown')
  )
}
function packageComponent(name, version, type, purl) {
  return { type, name, version, 'bom-ref': purl, purl }
}
function createBom(bom, appOutDir, inventory, electronVersion, backendPath) {
  const oldRoot = bom.metadata?.component?.['bom-ref']
  const appRef = 'pkg:npm/' + packageJson.name + '@' + packageJson.version
  const productionRefs = (bom.dependencies ?? []).find((d) => d.ref === oldRoot)?.dependsOn ?? []
  const electronRef = 'pkg:npm/electron@' + electronVersion
  const backendRef = 'pkg:generic/speed-ofreq-sonic-backend'
  // npm's CycloneDX output currently omits npm-alias packages from components/dependency edges.
  // Explicitly add the security-critical transitive alias used by bittorrent-tracker.
  const aliasedIp = lock.packages?.['node_modules/ip']
  const aliasedIpRef =
    aliasedIp?.name === '@bybrave/ip2' && aliasedIp.version
      ? 'pkg:npm/%40bybrave/ip2@' + aliasedIp.version
      : null
  const existing = new Set(bom.components.map(componentRef))
  bom.components = bom.components.filter((c) => componentRef(c) !== appRef)
  if (aliasedIpRef && aliasedIp && !existing.has(aliasedIpRef)) {
    const component = {
      type: 'library',
      name: aliasedIp.name,
      version: aliasedIp.version,
      'bom-ref': aliasedIpRef,
      purl: aliasedIpRef,
      scope: 'required',
      licenses: aliasedIp.license ? [{ license: { id: aliasedIp.license } }] : [],
      externalReferences: aliasedIp.resolved
        ? [{ type: 'distribution', url: aliasedIp.resolved }]
        : [],
      properties: [
        {
          name: 'sonic:dependency-alias',
          value: 'Installed as node_modules/ip for the bittorrent-tracker dependency'
        }
      ]
    }
    const integrity = aliasedIp.integrity?.match(/^sha512-(.+)$/)
    if (integrity) {
      component.hashes = [
        {
          alg: 'SHA-512',
          content: Buffer.from(integrity[1], 'base64').toString('hex')
        }
      ]
    }
    bom.components.push(component)
    existing.add(aliasedIpRef)
  }
  bom.metadata = bom.metadata ?? {}
  bom.metadata.component = {
    type: 'application',
    name: productName,
    version: packageJson.version,
    'bom-ref': appRef,
    purl: appRef,
    description: packageJson.description
  }
  bom.metadata.properties = [
    ...(bom.metadata.properties ?? []).filter((p) => !String(p.name).startsWith('sonic:sbom-')),
    {
      name: 'sonic:sbom-scope',
      value: appOutDir
        ? 'Windows app-output directory and embedded backend; signing state is verified separately. Final NSIS installer-container bytes are not represented by this BOM.'
        : 'Source dependency inventory only. Not a complete packaged-release SBOM.'
    },
    {
      name: 'sonic:sbom-source',
      value:
        'CycloneDX npm production dependency graph plus Electron runtime, .NET backend executable, and SHA-256 inventory of files in the packaged app directory when available.'
    },
    {
      name: 'sonic:sbom-self-reference',
      value:
        'The embedded SBOM is intentionally omitted from its own file-hash inventory to avoid recursive hashing.'
    }
  ]
  if (!existing.has(electronRef)) {
    bom.components.push(
      packageComponent('Electron runtime', electronVersion, 'framework', electronRef)
    )
  }
  if (backendPath) {
    bom.components.push({
      type: 'library',
      name: 'SpeedOFreq .NET backend executable',
      version: 'packaged-artifact',
      'bom-ref': backendRef,
      hashes: [{ alg: 'SHA-256', content: sha256File(backendPath) }],
      properties: [
        {
          name: 'sonic:package-path',
          value: relative(appOutDir, backendPath).split(sep).join('/')
        }
      ]
    })
  }
  for (const file of inventory) {
    const rel = relative(appOutDir, file).split(sep).join('/')
    if (rel.toLowerCase() === 'resources/sonic-sbom.cdx.json') continue
    const fileRef = 'file:' + rel
    if (existing.has(fileRef)) continue
    bom.components.push({
      type: 'file',
      name: rel,
      'bom-ref': fileRef,
      fileName: rel,
      hashes: [{ alg: 'SHA-256', content: sha256File(file) }]
    })
  }
  const refs = new Set(bom.components.map(componentRef))
  const dependsOn = [
    ...new Set([
      ...productionRefs,
      electronRef,
      ...(backendPath ? [backendRef] : []),
      ...inventory
        .map((file) => 'file:' + relative(appOutDir, file).split(sep).join('/'))
        .filter((ref) => !ref.toLowerCase().endsWith('resources/sonic-sbom.cdx.json'))
    ])
  ]
  bom.dependencies = (bom.dependencies ?? []).filter((d) => d.ref !== oldRoot && d.ref !== appRef)
  if (aliasedIpRef) {
    const trackerComponent = bom.components.find(
      (component) => component.name === 'bittorrent-tracker'
    )
    const trackerDependency = bom.dependencies.find(
      (dependency) => dependency.ref === componentRef(trackerComponent ?? {})
    )
    if (trackerDependency) {
      trackerDependency.dependsOn = [
        ...new Set([...(trackerDependency.dependsOn ?? []), aliasedIpRef])
      ]
    }
    if (!bom.dependencies.some((dependency) => dependency.ref === aliasedIpRef)) {
      bom.dependencies.push({ ref: aliasedIpRef, dependsOn: [] })
    }
  }
  bom.dependencies.push({
    ref: appRef,
    dependsOn: dependsOn.filter((ref) => refs.has(ref) || ref.startsWith('file:'))
  })
  bom.serialNumber = 'urn:uuid:' + randomUUID()
  bom.version = 1
  return bom
}

async function generate(appOutDirArgument = null) {
  const bom = parseNpmSbom()
  const electronVersion = lock.packages?.['node_modules/electron']?.version
  if (!electronVersion)
    throw new Error('Electron runtime version was not found in package-lock.json.')
  if (!appOutDirArgument) {
    const output = join(projectRoot, 'diagnostics', 'sonicui-source-dependencies-sbom.cdx.json')
    mkdirSync(dirname(output), { recursive: true })
    const result = createBom(bom, null, [], electronVersion, null)
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n', 'utf8')
    console.log(
      JSON.stringify(
        {
          mode: 'source-dependency-inventory',
          components: result.components.length,
          output,
          packageDirectoryHashed: false,
          releaseComplete: false
        },
        null,
        2
      )
    )
    console.warn(
      'No packaged app directory supplied; this is a source dependency inventory, not a complete release SBOM.'
    )
    return
  }

  const appOutDir = resolve(appOutDirArgument)
  if (!existsSync(appOutDir)) throw new Error('Packaged app directory does not exist: ' + appOutDir)
  const resources = join(appOutDir, 'resources')
  const backendDir = join(resources, 'sonic-backend')
  const backendFiles = walkFiles(backendDir)
  const backendPath =
    backendFiles.find((p) => p.toLowerCase().endsWith('.exe') && /speedofreq/i.test(p)) ?? null
  const inventory = walkFiles(appOutDir)
  if (inventory.length === 0) throw new Error('Packaged app directory contains no files.')
  mkdirSync(resources, { recursive: true })
  const embeddedPath = join(resources, 'sonic-sbom.cdx.json')
  const bomResult = createBom(bom, appOutDir, inventory, electronVersion, backendPath)
  const serialized = JSON.stringify(bomResult, null, 2) + '\n'
  writeFileSync(embeddedPath, serialized, 'utf8')
  const externalDir = join(projectRoot, 'diagnostics')
  mkdirSync(externalDir, { recursive: true })
  const externalCopy = join(externalDir, 'sonicui-packaged-sbom.cdx.json')
  writeFileSync(externalCopy, serialized, 'utf8')
  console.log(
    JSON.stringify(
      {
        mode: 'packaged-app',
        appOutDir,
        components: bomResult.components.length,
        fileCount: inventory.length,
        embedded: embeddedPath,
        externalCopy,
        electronVersion,
        backendIncluded: Boolean(backendPath),
        backendSha256: backendPath ? sha256File(backendPath) : null,
        installerContainerIncluded: false
      },
      null,
      2
    )
  )
  if (!backendPath) {
    throw new Error('Packaged .NET backend executable was not found; release SBOM is incomplete.')
  }
}

export default async function generatePackageSbom(context) {
  await generate(context?.appOutDir ?? null)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  await generate(process.argv[2] ?? null)
}
