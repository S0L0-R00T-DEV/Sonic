import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BLOCK, expect, test } from './fixtures'

test('legacy history array migrates to versioned history without losing entries', async ({
  sonic,
  serve,
  dirs
}) => {
  const first = await serve({ size: BLOCK })
  await sonic.start(first.url(), first.sha256)
  const firstDone = await sonic.waitForHttpStatus('completed')
  const historyPath = join(dirs.userData, 'history.json')
  const current = JSON.parse(await readFile(historyPath, 'utf8')) as {
    version?: number
    entries?: {
      id: string
      sha256?: string
      sha256Scope?: string
      startedAt: number
      completedAt?: number
      totalPausedMs?: number
      unitsWritten: number
      error?: string
      resumable?: boolean
    }[]
  }
  const legacyEntries = current.version === 1 ? current.entries : []
  expect(legacyEntries).toHaveLength(1)
  expect(legacyEntries?.[0].sha256).toBe(first.sha256)
  expect(legacyEntries?.[0].sha256Scope).toBe('file')
  expect(legacyEntries?.[0].startedAt).toBeLessThanOrEqual(legacyEntries?.[0].completedAt ?? 0)
  expect(legacyEntries?.[0].unitsWritten).toBeGreaterThan(0)
  expect(legacyEntries?.[0].error).toBeUndefined()
  expect(legacyEntries?.[0].resumable).toBeUndefined()
  const preservedMetadata = {
    startedAt: legacyEntries![0].startedAt,
    completedAt: legacyEntries![0].completedAt,
    unitsWritten: legacyEntries![0].unitsWritten,
    sha256: legacyEntries![0].sha256,
    sha256Scope: legacyEntries![0].sha256Scope
  }

  // Simulate the legacy schema written by the previous application version.
  await writeFile(historyPath, JSON.stringify(legacyEntries, null, 2), 'utf8')
  expect((await sonic.api.listHistory()).map((entry) => entry.id)).toContain(firstDone.id)

  const second = await serve({ size: BLOCK + 17 })
  await sonic.start(second.url(), second.sha256)
  const secondDone = await sonic.waitForHttpStatus('completed')

  const migrated = JSON.parse(await readFile(historyPath, 'utf8')) as {
    version: number
    entries: {
      id: string
      startedAt: number
      completedAt?: number
      totalPausedMs?: number
      unitsWritten: number
      sha256?: string
      sha256Scope?: string
    }[]
  }
  expect(migrated.version).toBe(1)
  expect(migrated.entries.map((entry) => entry.id)).toEqual([secondDone.id, firstDone.id])
  expect(migrated.entries[1]).toMatchObject(preservedMetadata)
  expect(migrated.entries[1].startedAt).toBeLessThanOrEqual(migrated.entries[1].completedAt ?? 0)
  expect(migrated.entries[1].sha256).toBe(first.sha256)
  expect(migrated.entries[1].sha256Scope).toBe('file')
})

test('malformed history is preserved before a new history file is written', async ({
  sonic,
  serve,
  dirs
}) => {
  const first = await serve({ size: BLOCK })
  await sonic.start(first.url(), first.sha256)
  await sonic.waitForHttpStatus('completed')

  const historyPath = join(dirs.userData, 'history.json')
  const malformed = '{ "entries": [ this is not valid JSON'
  await writeFile(historyPath, malformed, 'utf8')

  const second = await serve({ size: BLOCK + 31 })
  await sonic.start(second.url(), second.sha256)
  await sonic.waitForHttpStatus('completed')

  const files = await readdir(dirs.userData)
  const backupName = files.find((name) => name.startsWith('history.json.corrupt-'))
  expect(backupName, 'the malformed original should be kept as a recovery backup').toBeTruthy()
  expect(await readFile(join(dirs.userData, backupName!), 'utf8')).toBe(malformed)

  const current = JSON.parse(await readFile(historyPath, 'utf8')) as {
    version: number
    entries: { id: string }[]
  }
  expect(current.version).toBe(1)
  expect(current.entries).toHaveLength(1)
  expect(existsSync(join(dirs.userData, backupName!))).toBe(true)
})
