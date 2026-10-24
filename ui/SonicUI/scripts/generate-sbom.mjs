import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'generate-package-sbom.mjs')
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync(process.execPath, [scriptPath, ...process.argv.slice(2)], {
  cwd: projectRoot,
  stdio: 'inherit',
  windowsHide: true
})

if (result.error) {
  console.error('Could not run the canonical SBOM generator:', result.error.message)
  process.exitCode = 1
} else {
  process.exitCode = result.status ?? 1
}
