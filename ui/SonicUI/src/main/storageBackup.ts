import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { app } from 'electron'

const FORMAT = 'speed-o-freq-sonic-backup'
const SETTINGS_FORMAT = 'speed-o-freq-sonic-settings-backup'
const HISTORY_FORMAT = 'speed-o-freq-sonic-history-backup'
const VERSION = 1
const MAX_BACKUP_BYTES = 100 * 1024 * 1024

type BackupFile = { name: string; content: string }
type BackupTask = { id: string; manifest: string; torrentMetadata?: string }
type BackupDocument = {
  format: typeof FORMAT
  version: typeof VERSION
  createdAt: string
  appVersion: string
  files: BackupFile[]
  tasks: BackupTask[]
  mediaTasks: BackupFile[]
}

function root(): string {
  return app.getPath('userData')
}
function safeId(id: string): boolean {
  return /^[a-f0-9-]{36}$/i.test(id)
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function createSettingsBackup(): Promise<string> {
  const raw = await readOptional(join(root(), 'app-settings.json'))
  let settings: unknown = {}
  if (raw) {
    try {
      settings = JSON.parse(raw)
    } catch {
      throw new Error('Saved Sonic settings are malformed and cannot be exported.')
    }
  }
  if (!isRecord(settings)) throw new Error('Saved Sonic settings have an unsupported format.')
  const serialized = JSON.stringify({
    format: SETTINGS_FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    settings
  }, null, 2) + '\n'
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BACKUP_BYTES)
    throw new Error('Settings backup exceeds the 100 MiB safety limit.')
  return serialized
}

export async function restoreSettingsBackup(serialized: string): Promise<{ settingsRestored: boolean }> {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_BACKUP_BYTES)
    throw new Error('Settings backup is invalid or exceeds the 100 MiB safety limit.')
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('Settings backup is not valid JSON.')
  }
  if (!isRecord(value) || value.format !== SETTINGS_FORMAT || value.version !== VERSION || !isRecord(value.settings))
    throw new Error('This file is not a supported Sonic settings backup.')
  const base = root()
  const path = join(base, 'app-settings.json')
  const currentRaw = await readOptional(path)
  if (currentRaw !== undefined) {
    const safetyDir = join(base, 'pre-settings-restore-' + new Date().toISOString().replace(/[:.]/g, '-'))
    await mkdir(safetyDir, { recursive: true })
    await writeFile(join(safetyDir, 'app-settings.json'), currentRaw, { encoding: 'utf8', mode: 0o600 })
  }
  await writeFile(path, JSON.stringify(value.settings, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  return { settingsRestored: true }
}

export function isSettingsBackup(serialized: string): boolean {
  try {
    const value: unknown = JSON.parse(serialized)
    return isRecord(value) && value.format === SETTINGS_FORMAT && value.version === VERSION && isRecord(value.settings)
  } catch {
    return false
  }
}

export async function createStorageBackup(): Promise<string> {
  const base = root()
  const files: BackupFile[] = []
  for (const name of [
    'app-settings.json',
    'history.json',
    'network-usage.json',
    'network-usage-v1.json'
  ]) {
    const content = await readOptional(join(base, name))
    if (content !== undefined) files.push({ name, content })
  }
  const tasks: BackupTask[] = []
  const taskRoot = join(base, 'downloads')
  for (const id of await readdir(taskRoot).catch(() => [])) {
    if (!safeId(id)) continue
    const folder = join(taskRoot, id)
    const manifest = await readOptional(join(folder, 'manifest.json'))
    if (manifest === undefined) continue
    let torrentMetadata: string | undefined
    try {
      torrentMetadata = await readFile(join(folder, 'metadata.torrent')).then((data) =>
        data.toString('base64')
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    tasks.push({ id, manifest, ...(torrentMetadata === undefined ? {} : { torrentMetadata }) })
  }
  const mediaTasks: BackupFile[] = []
  const mediaRoot = join(base, 'media-downloads')
  for (const name of await readdir(mediaRoot).catch(() => [])) {
    if (!/^[a-f0-9-]{36}\.json$/i.test(name)) continue
    const content = await readOptional(join(mediaRoot, name))
    if (content !== undefined) mediaTasks.push({ name, content })
  }
  const document: BackupDocument = {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    files,
    tasks,
    mediaTasks
  }
  const serialized = JSON.stringify(document, null, 2) + '\n'
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BACKUP_BYTES)
    throw new Error('Backup exceeds the 100 MiB safety limit.')
  return serialized
}

export async function restoreStorageBackup(serialized: string): Promise<{
  settingsRestored: boolean
  historyEntries: number
  tasksRestored: number
  mediaTasksRestored: number
}> {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_BACKUP_BYTES)
    throw new Error('Backup is invalid or exceeds the 100 MiB safety limit.')
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('Backup is not valid JSON.')
  }
  if (
    !isRecord(value) ||
    value.format !== FORMAT ||
    value.version !== VERSION ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.tasks) ||
    !Array.isArray(value.mediaTasks)
  )
    throw new Error('Unsupported or malformed Sonic backup.')
  const base = root()
  const safetyDir = join(
    base,
    'pre-restore-backup-' + new Date().toISOString().replace(/[:.]/g, '-')
  )
  await mkdir(safetyDir, { recursive: true })
  for (const name of ['app-settings.json', 'history.json']) {
    const path = join(base, name)
    if (
      await stat(path).then(
        () => true,
        () => false
      )
    )
      await copyFile(path, join(safetyDir, name))
  }
  let settingsRestored = false
  let historyEntries = 0
  for (const item of value.files) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.content !== 'string')
      throw new Error('Backup contains an invalid settings/history file entry.')
    if (
      ![
        'app-settings.json',
        'history.json',
        'network-usage.json',
        'network-usage-v1.json'
      ].includes(item.name)
    )
      continue
    const path = join(base, item.name)
    if (item.name === 'history.json') {
      let imported: unknown
      try {
        imported = JSON.parse(item.content)
      } catch {
        continue
      }
      const incoming = Array.isArray(imported)
        ? imported
        : isRecord(imported) && Array.isArray(imported.entries)
          ? imported.entries
          : []
      const currentRaw = await readOptional(path)
      let current: unknown
      try {
        current = currentRaw ? JSON.parse(currentRaw) : []
      } catch {
        current = []
      }
      const currentEntries = Array.isArray(current)
        ? current
        : isRecord(current) && Array.isArray(current.entries)
          ? current.entries
          : []
      const byId = new Map<string, unknown>()
      for (const entry of [...currentEntries, ...incoming])
        if (isRecord(entry) && typeof entry.id === 'string') byId.set(entry.id, entry)
      historyEntries = incoming.length
      await writeFile(
        path,
        JSON.stringify({ version: 1, entries: [...byId.values()].slice(-500).reverse() }, null, 2) +
          '\n',
        'utf8'
      )
    } else {
      if (item.name === 'app-settings.json') {
        let parsed: unknown
        try {
          parsed = JSON.parse(item.content)
        } catch {
          throw new Error('Backup app settings are malformed; restore was stopped.')
        }
        if (!isRecord(parsed))
          throw new Error('Backup app settings are not an object; restore was stopped.')
        settingsRestored = true
      }
      await writeFile(path, item.content, 'utf8')
    }
  }
  let tasksRestored = 0
  for (const item of value.tasks) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !safeId(item.id) ||
      typeof item.manifest !== 'string'
    )
      throw new Error('Backup contains an invalid download manifest.')
    let manifest: unknown
    try {
      manifest = JSON.parse(item.manifest)
    } catch {
      throw new Error('Download manifest is malformed.')
    }
    if (!isRecord(manifest) || !isRecord(manifest.state) || manifest.state.id !== item.id)
      throw new Error('Download manifest identity mismatch.')
    const folder = join(base, 'downloads', item.id)
    await mkdir(folder, { recursive: true })
    const path = join(folder, 'manifest.json')
    if (
      await stat(path).then(
        () => true,
        () => false
      )
    )
      continue
    await writeFile(path, item.manifest, 'utf8')
    if (typeof item.torrentMetadata === 'string') {
      const bytes = Buffer.from(item.torrentMetadata, 'base64')
      if (bytes.length > 20 * 1024 * 1024)
        throw new Error('Torrent metadata exceeds the safety limit.')
      await writeFile(join(folder, 'metadata.torrent'), bytes)
    }
    tasksRestored++
  }
  let mediaTasksRestored = 0
  for (const item of value.mediaTasks) {
    if (
      !isRecord(item) ||
      typeof item.name !== 'string' ||
      !/^[a-f0-9-]{36}\.json$/i.test(item.name) ||
      typeof item.content !== 'string'
    )
      throw new Error('Backup contains an invalid media manifest.')
    let manifest: unknown
    try {
      manifest = JSON.parse(item.content)
    } catch {
      throw new Error('Media manifest is malformed.')
    }
    if (!isRecord(manifest) || manifest.id !== basename(item.name, '.json'))
      throw new Error('Media manifest identity mismatch.')
    const folder = join(base, 'media-downloads')
    await mkdir(folder, { recursive: true })
    const path = join(folder, item.name)
    if (
      await stat(path).then(
        () => true,
        () => false
      )
    )
      continue
    await writeFile(path, item.content, 'utf8')
    mediaTasksRestored++
  }
  return { settingsRestored, historyEntries, tasksRestored, mediaTasksRestored }
}

export async function createHistoryBackup(): Promise<string> {
  const raw = await readOptional(join(root(), 'history.json'))
  let parsed: unknown = []
  if (raw) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('Saved download history is malformed and cannot be exported.')
    }
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.entries)
      ? parsed.entries
      : null
  if (!entries) throw new Error('Saved download history has an unsupported format.')
  const serialized = JSON.stringify({
    format: HISTORY_FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    entries
  }, null, 2)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BACKUP_BYTES)
    throw new Error('History backup exceeds the 100 MiB safety limit.')
  return serialized
}

export async function restoreHistoryBackup(serialized: string): Promise<{ historyEntries: number }> {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_BACKUP_BYTES)
    throw new Error('History backup is invalid or exceeds the 100 MiB safety limit.')
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('History backup is not valid JSON.')
  }
  if (!isRecord(value) || value.format !== HISTORY_FORMAT || value.version !== VERSION || !Array.isArray(value.entries))
    throw new Error('This file is not a supported Sonic download-history backup.')
  if (!value.entries.every((entry) => isRecord(entry) && typeof entry.id === 'string'))
    throw new Error('History backup contains an invalid entry.')
  const base = root()
  const path = join(base, 'history.json')
  const safetyDir = join(base, 'pre-history-restore-' + new Date().toISOString().replace(/[:.]/g, '-'))
  const currentRaw = await readOptional(path)
  if (currentRaw !== undefined) {
    await mkdir(safetyDir, { recursive: true })
    await writeFile(join(safetyDir, 'history.json'), currentRaw, { encoding: 'utf8', mode: 0o600 })
  }
  let current: unknown = []
  if (currentRaw) {
    try { current = JSON.parse(currentRaw) } catch { current = [] }
  }
  const currentEntries = Array.isArray(current)
    ? current
    : isRecord(current) && Array.isArray(current.entries)
      ? current.entries
      : []
  const byId = new Map<string, unknown>()
  for (const entry of [...currentEntries, ...value.entries])
    if (isRecord(entry) && typeof entry.id === 'string') byId.set(entry.id, entry)
  await writeFile(path, JSON.stringify({ version: 1, entries: [...byId.values()].slice(-500).reverse() }, null, 2), 'utf8')
  return { historyEntries: value.entries.length }
}

export function isHistoryBackup(serialized: string): boolean {
  try {
    const value: unknown = JSON.parse(serialized)
    return isRecord(value) && value.format === HISTORY_FORMAT && value.version === VERSION
  } catch {
    return false
  }
}
