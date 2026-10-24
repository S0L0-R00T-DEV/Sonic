import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app } from 'electron'

type PortableConfig = { version: 1; userDataDir: string }
function configPath(): string {
  return join(app.getPath('appData'), "Speed-o'-Freq Sonic", 'portable-mode.json')
}

export async function configuredPortableDir(): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<PortableConfig>
    if (parsed.version !== 1 || typeof parsed.userDataDir !== 'string') return undefined
    return resolve(parsed.userDataDir)
  } catch {
    return undefined
  }
}

/** Copies user state to an empty user-selected folder before switching on the next launch. */
export async function configurePortableDir(selected: string | null): Promise<string | null> {
  const marker = configPath()
  if (selected === null) {
    await rm(marker, { force: true })
    return null
  }
  const destination = resolve(selected)
  const current = resolve(app.getPath('userData'))
  if (destination.toLowerCase() === current.toLowerCase()) {
    throw new Error('Choose a different folder for portable storage.')
  }
  await mkdir(destination, { recursive: true })
  const entries = await readdir(destination)
  if (entries.length > 0) {
    throw new Error(
      'Portable storage must be an empty folder. Choose an empty folder to avoid overwriting existing files.'
    )
  }
  for (const entry of await readdir(current)) {
    await cp(join(current, entry), join(destination, entry), {
      recursive: true,
      force: false,
      errorOnExist: true
    })
  }
  await mkdir(join(app.getPath('appData'), "Speed-o'-Freq Sonic"), { recursive: true })
  await writeFile(
    marker,
    JSON.stringify({ version: 1, userDataDir: destination }, null, 2) + '\n',
    { encoding: 'utf8', mode: 0o600 }
  )
  return destination
}
