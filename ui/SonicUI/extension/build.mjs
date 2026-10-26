import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))
const out = join(root, 'dist')
const scripts = join(out, 'scripts')

await rm(out, { recursive: true, force: true })

// Build a self-contained script for each browser extension entry point.
for (const name of ['background', 'popup', 'options']) {
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    build: {
      outDir: scripts,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: join(root, 'src', `${name}.ts`),
        formats: ['iife'],
        name: 'speedOFreqSonic',
        fileName: () => `${name}.js`
      }
    }
  })
}

const base = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf-8'))
const manifests = {
  chromium: {
    ...base,
    minimum_chrome_version: '123',
    background: { service_worker: 'background.js' }
  },
  firefox: {
    ...base,
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      gecko: {
        id: 'sonic-download-manager-4f8a9e2d-7b31-4c65-9a42-8c1f0d73b6e5@sonic.local',
        strict_min_version: '121.0',
        data_collection_permissions: { required: ['none'] }
      }
    }
  }
}

for (const [browser, manifest] of Object.entries(manifests)) {
  const dir = join(out, browser)
  await mkdir(dir, { recursive: true })
  await cp(scripts, dir, { recursive: true })
  for (const file of ['popup.html', 'options.html', 'ui.css']) {
    await cp(join(root, 'src', file), join(dir, file))
  }
  await cp(join(root, 'INSTALL.md'), join(dir, 'INSTALL.md'))
  // Manifest icon paths are relative to each package root; keep them in both browser builds.
  await cp(join(root, 'icons'), join(dir, 'icons'), { recursive: true })
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  // Fail the build if any manifest-referenced asset was accidentally omitted from the package.
  const requiredAssets = new Set([
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...(manifest.background.service_worker
      ? [manifest.background.service_worker]
      : manifest.background.scripts ?? (manifest.background.page ? [manifest.background.page] : []))
  ])
  for (const asset of requiredAssets) {
    try {
      await readFile(join(dir, asset))
    } catch {
      throw new Error(`${browser} extension package is missing manifest asset: ${asset}`)
    }
  }
}

// Keep a Firefox XPI available to the development app and packaged release.
const xpiPath = join(out, 'SDMFFE.xpi')
const zipPath = join(out, 'SDMFFE.zip')
await rm(xpiPath, { force: true })
await rm(zipPath, { force: true })
const firefoxDir = join(out, 'firefox').replace(/'/g, "''")
const destination = zipPath.replace(/'/g, "''")
const archive = spawnSync(
  process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$ErrorActionPreference = 'Stop'; Compress-Archive -Path '${firefoxDir}\\*' -DestinationPath '${destination}' -CompressionLevel Optimal`
  ],
  { encoding: 'utf8', windowsHide: true }
)
if (archive.error || archive.status !== 0) {
  throw new Error(
    `Failed to create SDMFFE.xpi: ${archive.error?.message ?? archive.stderr ?? `exit code ${archive.status}`}`
  )
}
await rename(zipPath, xpiPath)
const xpiContents = await readFile(xpiPath)
if (xpiContents.length === 0) throw new Error('Generated SDMFFE.xpi is empty.')
