import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  chrome: {
    ...base,
    minimum_chrome_version: '123',
    background: { service_worker: 'background.js' }
  },
  firefox: {
    ...base,
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      gecko: {
        id: 'extension@speedofreqsonic.local',
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
  // Manifest icon paths are relative to each package root; keep them in both browser builds.
  await cp(join(root, 'icons'), join(dir, 'icons'), { recursive: true })
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  // Fail the build if any manifest-referenced asset was accidentally omitted from the package.
  const requiredAssets = new Set([
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...(manifest.background.service_worker
      ? [manifest.background.service_worker]
      : manifest.background.scripts)
  ])
  for (const asset of requiredAssets) {
    try {
      await readFile(join(dir, asset))
    } catch {
      throw new Error(`${browser} extension package is missing manifest asset: ${asset}`)
    }
  }
}
