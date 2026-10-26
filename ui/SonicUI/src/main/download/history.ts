import { copyFile, readFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { FinishedDownload } from '../../shared/types'
import { readJson, updateJson } from '../jsonFile'

// Finished downloads, newest first. Keep a versioned envelope for future migrations while
// continuing to read the legacy top-level array written by older Sonic builds.
const HISTORY_VERSION = 1
const MAX_ENTRIES = 500

function historyPath(): string {
  return join(app.getPath('userData'), 'history.json')
}

type HistoryDocument = { version: typeof HISTORY_VERSION; entries: FinishedDownload[] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isEntry(value: unknown): value is FinishedDownload {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    (value.kind === 'http' || value.kind === 'torrent') &&
    typeof value.url === 'string' &&
    typeof value.fileName === 'string' &&
    typeof value.destinationPath === 'string' &&
    typeof value.totalBytes === 'number' &&
    Number.isFinite(value.totalBytes) &&
    typeof value.bytesDownloaded === 'number' &&
    Number.isFinite(value.bytesDownloaded) &&
    typeof value.startedAt === 'number' &&
    Number.isFinite(value.startedAt) &&
    typeof value.completedAt === 'number' &&
    Number.isFinite(value.completedAt) &&
    typeof value.unitsWritten === 'number' &&
    Number.isFinite(value.unitsWritten) &&
    Array.isArray(value.networks) &&
    value.networks.every(isRecord)
  )
}

function rawEntries(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed
  if (isRecord(parsed) && parsed.version === HISTORY_VERSION && Array.isArray(parsed.entries)) {
    return parsed.entries
  }
  return undefined
}

function entriesOf(parsed: unknown): FinishedDownload[] {
  return (rawEntries(parsed) ?? []).filter(isEntry)
}

function documentOf(entries: FinishedDownload[]): HistoryDocument {
  return { version: HISTORY_VERSION, entries: entries.slice(0, MAX_ENTRIES) }
}

/**
 * Preserve unreadable/unknown history before a write can replace it. Mixed-validity documents
 * are copied (not moved) so valid entries can still be recovered into the active history.
 */
async function preserveInvalidHistory(): Promise<void> {
  const path = historyPath()
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    const backup = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
    await rename(path, backup)
    return
  }

  const candidates = rawEntries(parsed)
  if (!candidates) {
    const backup = `${path}.unsupported-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
    await rename(path, backup)
    return
  }
  if (candidates.some((entry) => !isEntry(entry))) {
    const backup = `${path}.partial-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
    await copyFile(path, backup)
  }
}

/** Every finished download, newest first; mark it missing when its output is gone. */
export async function listHistory(): Promise<FinishedDownload[]> {
  const entries = entriesOf(await readJson(historyPath()).catch(() => undefined))
  return Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      missing: !(await stat(entry.destinationPath).then(
        () => true,
        () => false
      ))
    }))
  )
}

/** One finished download, checking only its file. */
export async function findInHistory(id: string): Promise<FinishedDownload | undefined> {
  const entry = entriesOf(await readJson(historyPath()).catch(() => undefined)).find(
    (other) => other.id === id
  )
  if (!entry) return undefined
  const missing = !(await stat(entry.destinationPath).then(
    () => true,
    () => false
  ))
  return { ...entry, missing }
}

// Serialize the preservation check with each mutation: two concurrent saves must not race to
// rename the same corrupt file or reorder each other's entries.
let historyMutation: Promise<void> = Promise.resolve()

function serializeHistoryMutation(mutate: () => Promise<void>): Promise<void> {
  const next = historyMutation.catch(() => {}).then(mutate)
  historyMutation = next
  return next
}

export function addToHistory(entry: FinishedDownload): Promise<void> {
  return serializeHistoryMutation(async () => {
    await preserveInvalidHistory()
    const { missing: omitted, ...kept } = entry
    void omitted
    await updateJson(historyPath(), (current) =>
      documentOf(
        [kept, ...entriesOf(current).filter((other) => other.id !== entry.id)].slice(0, MAX_ENTRIES)
      )
    )
  })
}

/** Mark an entry removed from the main list without deleting its durable history record. */
export function markHistoryRemoved(id: string): Promise<void> {
  return serializeHistoryMutation(async () => {
    await preserveInvalidHistory()
    await updateJson(historyPath(), (current) =>
      documentOf(
        entriesOf(current).map((entry) =>
          entry.id === id ? { ...entry, removedAt: Date.now() } : entry
        )
      )
    )
  })
}

/** Forget entries, not the files themselves. */
export function removeFromHistory(ids?: string[]): Promise<void> {
  return serializeHistoryMutation(async () => {
    await preserveInvalidHistory()
    await updateJson(historyPath(), (current) =>
      documentOf(ids ? entriesOf(current).filter((entry) => !ids.includes(entry.id)) : [])
    )
  })
}
