import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(scriptDir, '..')
const projectRoot = resolve(appRoot, '..', '..')
const project = join(projectRoot, 'src', 'SpeedOFreq.App', 'SpeedOFreq.App.csproj')
const output = join(projectRoot, 'artifacts', 'sonic-backend-current', 'win-x64')

if (!existsSync(project)) throw new Error(`Backend project not found: ${project}`)
rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })

console.log(`Publishing current self-contained Windows x64 backend to ${output}`)
const result = spawnSync(
  'dotnet',
  [
    'publish',
    project,
    '--configuration',
    'Release',
    '--runtime',
    'win-x64',
    '--self-contained',
    'true',
    '--output',
    output
  ],
  { cwd: projectRoot, stdio: 'inherit', windowsHide: true }
)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

for (const name of ['SpeedOFreq.exe', 'SpeedOFreq.dll', 'SpeedOFreq.Core.dll']) {
  const path = join(output, name)
  if (!existsSync(path)) throw new Error(`Published backend is missing ${name}`)
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
  console.log(`SHA256 ${name}: ${hash}`)
}
console.log('Current self-contained backend is ready for Electron packaging.')
