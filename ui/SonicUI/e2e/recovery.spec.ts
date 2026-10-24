import { cp, mkdir, readFile, readdir, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BLOCK, expect, test } from './fixtures'
import { seededBytes } from './origin'

// D. Quitting, crashing and restarting. kill() is SIGKILL: no before-quit handler or final save.
// The disk state is exactly what the app persisted before termination, as after a crash or power cut.

const SIZE = 32 * BLOCK

test.describe('restart @smoke', () => {
  test('normal quit mid-download, relaunch paused, then resume', async ({ sonic, serve }) => {
    const origin = await serve({ size: SIZE })
    const reached = origin.hold(10 * BLOCK + 500)
    const id = await sonic.start(origin.url(), origin.sha256, { connections: 2 })
    await reached

    await sonic.quit()
    origin.release()
    await sonic.launch()

    const restored = await sonic.currentHttp()
    expect(restored?.id).toBe(id)
    expect(restored?.status).toBe('paused')
    expect(restored?.bytesDownloaded).toBeGreaterThan(0)

    await sonic.api.resumeDownload(id)
    await sonic.waitForHttpStatus('completed')
  })
})

test.describe('crash (SIGKILL) and recover @smoke', () => {
  // Offsets chosen to leave different part-file and manifest states behind: so early no progress
  // has been saved yet, and mid-block. Chaos covers the moments in between.
  for (const offset of [100, 3 * BLOCK + 777]) {
    test(`killed with a response held at byte ${offset}`, async ({ sonic, serve }) => {
      const origin = await serve({ size: SIZE, seed: offset })
      const reached = origin.hold(offset)
      const id = await sonic.start(origin.url(), origin.sha256, { connections: 4 })
      await reached
      // Give progress events and the throttled manifest save a chance to (partly) happen.
      await sonic.waitUntil((state) => state.bytesDownloaded > 0)

      await sonic.kill()
      origin.release()
      await sonic.launch()

      const restored = await sonic.currentHttp()
      expect(restored?.id).toBe(id)
      expect(restored?.status).toBe('paused')

      await sonic.api.resumeDownload(id)
      await sonic.waitForHttpStatus('completed')
    })
  }
})

test.describe('persisted state on disk @smoke', () => {
  async function pausedDownload(
    sonic: import('./fixtures').SonicApp,
    serve: (o: { size: number; seed?: number }) => Promise<import('./origin').Origin>,
    seed = 1
  ): Promise<{ id: string; origin: import('./origin').Origin }> {
    const origin = await serve({ size: SIZE, seed })
    const reached = origin.hold(8 * BLOCK)
    const id = await sonic.start(origin.url(), origin.sha256)
    await reached
    await sonic.api.pauseDownload(id)
    await sonic.waitForHttpStatus('paused')
    origin.release()
    return { id, origin }
  }

  test('a valid temporary checkpoint recovers when the manifest rename was interrupted', async ({
    sonic,
    serve,
    dirs
  }) => {
    const { id } = await pausedDownload(sonic, serve, 42)
    await sonic.quit()
    const manifestPath = join(dirs.userData, 'downloads', id, 'manifest.json')
    const temporaryPath = `${manifestPath}.tmp`
    await rm(temporaryPath, { force: true })
    await rename(manifestPath, temporaryPath)

    await sonic.launch()
    expect((await sonic.currentHttp())?.id).toBe(id)
    expect((await sonic.currentHttp())?.status).toBe('paused')
    await expect.poll(() => existsSync(manifestPath)).toBe(true)
    await expect.poll(() => existsSync(temporaryPath)).toBe(false)
    expect(JSON.parse(await readFile(manifestPath, 'utf-8')).version).toBe(7)

    await sonic.api.resumeDownload(id)
    await sonic.waitForHttpStatus('completed')
  })

  test('a corrupt manifest does not stop the app from starting', async ({ sonic, serve, dirs }) => {
    const { id } = await pausedDownload(sonic, serve)
    await sonic.quit()
    await writeFile(join(dirs.userData, 'downloads', id, 'manifest.json'), 'not json {')
    await sonic.launch()
    expect(await sonic.currentHttp()).toBeNull()
    await expect(sonic.page.getByRole('alert')).toContainText('A saved download needs attention')
    await expect(sonic.page.getByRole('alert')).toContainText('main manifest is malformed')
    // Malformed recovery material is preserved for inspection rather than deleted automatically.
    await expect.poll(() => existsSync(join(dirs.userData, 'downloads', id))).toBe(true)
    expect(await readFile(join(dirs.userData, 'downloads', id, 'manifest.json'), 'utf-8')).toBe(
      'not json {'
    )

    // And a new download still works.
    const origin = await serve({ size: 4 * BLOCK, seed: 99 })
    await sonic.start(origin.url(), origin.sha256)
    await sonic.waitForHttpStatus('completed')
  })

  test('two saved downloads of one partial file: newest restored, older manifest preserved', async ({
    sonic,
    serve,
    dirs
  }) => {
    const { id } = await pausedDownload(sonic, serve)
    await sonic.quit()

    // Clone the saved download under another id, dated an hour earlier.
    const root = join(dirs.userData, 'downloads')
    const olderId = '00000000-0000-4000-8000-000000000000'
    await cp(join(root, id), join(root, olderId), { recursive: true })
    const manifestPath = join(root, olderId, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
    manifest.state.id = olderId
    manifest.state.startedAt -= 3_600_000
    await writeFile(manifestPath, JSON.stringify(manifest))

    await sonic.launch()
    expect((await sonic.currentHttp())?.id).toBe(id)
    // The older manifest still claims the same partial path, so it is flagged rather than erased.
    await expect.poll(() => existsSync(join(root, olderId))).toBe(true)
    expect(JSON.parse(await readFile(manifestPath, 'utf-8')).state.id).toBe(olderId)

    await sonic.api.resumeDownload(id)
    await sonic.waitForHttpStatus('completed')
  })

  test('staging file deleted while the app was closed reports lost progress', async ({
    sonic,
    serve
  }) => {
    await pausedDownload(sonic, serve)
    const partial = `${(await sonic.currentHttp())!.destinationPath}.sonic`
    await sonic.quit()
    await rm(partial)
    await sonic.launch()
    expect((await sonic.currentHttp())?.status).toBe('error')
    expect((await sonic.currentHttp())?.error).toMatch(/partial download file is missing/)
  })

  test('a terminal content-change failure retains its error metadata across restart', async ({
    sonic,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: SIZE, seed: 51 })
    const reached = origin.hold(5 * BLOCK)
    const id = await sonic.start(origin.url(), origin.sha256)
    await reached
    await sonic.api.pauseDownload(id)
    const paused = await sonic.waitForHttpStatus('paused')
    const originalStartedAt = paused.startedAt
    const originalBytes = paused.bytesDownloaded
    origin.setContent(seededBytes(SIZE, 52), '"changed-version"')
    origin.release()
    await sonic.api.resumeDownload(id)
    const failed = await sonic.waitForHttpStatus('error')
    expect(failed.error).toMatch(/changed/i)
    expect(failed.resumable).toBe(false)
    expect(failed.startedAt).toBe(originalStartedAt)
    expect(failed.bytesDownloaded).toBeGreaterThan(0)

    const manifestPath = join(dirs.userData, 'downloads', id, 'manifest.json')
    const savedBeforeRestart = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(savedBeforeRestart.state).toMatchObject({
      id,
      status: 'error',
      error: failed.error,
      resumable: false,
      startedAt: originalStartedAt
    })
    expect(savedBeforeRestart.state.bytesDownloaded).toBe(failed.bytesDownloaded)
    expect(savedBeforeRestart.state.bytesDownloaded).toBeGreaterThanOrEqual(originalBytes)

    await sonic.quit()
    await sonic.launch()
    const restored = await sonic.currentHttp()
    expect(restored?.id).toBe(id)
    expect(restored?.status).toBe('error')
    expect(restored?.error).toBe(failed.error)
    expect(restored?.resumable).toBe(false)
    expect(restored?.startedAt).toBe(originalStartedAt)
    expect(restored?.bytesDownloaded).toBe(failed.bytesDownloaded)
    const savedAfterRestart = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(savedAfterRestart.state).toMatchObject({
      status: 'error',
      error: failed.error,
      resumable: false,
      startedAt: originalStartedAt,
      bytesDownloaded: failed.bytesDownloaded
    })
    expect(await sonic.api.listHistory()).toHaveLength(0)
  })

  test('a compatible version 6 manifest is migrated and resumed', async ({
    sonic,
    serve,
    dirs
  }) => {
    const { id } = await pausedDownload(sonic, serve)
    await sonic.quit()
    const manifestPath = join(dirs.userData, 'downloads', id, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
    manifest.version = 6
    await writeFile(manifestPath, JSON.stringify(manifest))

    await sonic.launch()
    expect((await sonic.currentHttp())?.id).toBe(id)
    expect((await sonic.currentHttp())?.status).toBe('paused')
    await expect.poll(async () => JSON.parse(await readFile(manifestPath, 'utf-8')).version).toBe(7)
    const manifestDirectory = join(dirs.userData, 'downloads', id)
    const backupName = (await readdir(manifestDirectory)).find(
      (name) => name.startsWith('manifest.json.v6-') && name.endsWith('.bak')
    )
    expect(backupName).toBeDefined()
    if (!backupName) throw new Error('Version 6 migration backup was not created.')
    expect(JSON.parse(await readFile(join(manifestDirectory, backupName), 'utf-8')).version).toBe(6)

    await sonic.api.resumeDownload(id)
    await sonic.waitForHttpStatus('completed')
  })

  test('future-version manifests are preserved and not restored', async ({
    sonic,
    serve,
    dirs
  }) => {
    const { id } = await pausedDownload(sonic, serve, 77)
    await sonic.quit()
    const root = join(dirs.userData, 'downloads', id)
    const manifestPath = join(root, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
    manifest.version = 99
    const futureBytes = JSON.stringify(manifest)
    await writeFile(manifestPath, futureBytes)

    await sonic.launch()
    expect(await sonic.currentHttp()).toBeNull()
    expect(await readFile(manifestPath, 'utf-8')).toBe(futureBytes)
    await expect.poll(() => existsSync(root)).toBe(true)
    await expect.poll(() => existsSync(manifest.state.destinationPath + '.sonic')).toBe(true)
  })

  test('version 6 manifest with incompatible checkpoint layout is preserved', async ({
    sonic,
    serve,
    dirs
  }) => {
    const { id } = await pausedDownload(sonic, serve, 78)
    await sonic.quit()
    const root = join(dirs.userData, 'downloads', id)
    const manifestPath = join(root, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
    manifest.version = 6
    delete manifest.partialPath
    const incompatibleBytes = JSON.stringify(manifest)
    await writeFile(manifestPath, incompatibleBytes)

    await sonic.launch()
    expect(await sonic.currentHttp()).toBeNull()
    expect(await readFile(manifestPath, 'utf-8')).toBe(incompatibleBytes)
    await expect.poll(() => existsSync(root)).toBe(true)
    await expect.poll(() => existsSync(manifest.state.destinationPath + '.sonic')).toBe(true)
  })
  test('unsupported older manifests are preserved, but not restored', async ({
    sonic,
    serve,
    dirs
  }) => {
    // A paused download of this version's, which the clearing must leave alone.
    const { id } = await pausedDownload(sonic, serve)
    await sonic.quit()
    const root = join(dirs.userData, 'downloads')
    const manifest = (folder: string, content: object): Promise<void> =>
      mkdir(join(root, folder), { recursive: true }).then(() =>
        writeFile(join(root, folder, 'manifest.json'), JSON.stringify(content))
      )

    // What releases rc.1 through rc.9 left behind: a version-2 manifest, parts in a dedicated
    // folder, and the final path incorrectly claimed as an empty file.
    const oldId = '00000000-0000-4000-8000-000000000002'
    const placeholder = join(dirs.dest, 'old-movie.mkv')
    await manifest(oldId, {
      version: 2,
      state: { id: oldId, destinationPath: placeholder, status: 'paused' }
    })
    await mkdir(join(root, oldId, 'parts'))
    await writeFile(join(root, oldId, 'parts', '0'), seededBytes(1000, 5))
    await writeFile(placeholder, '')

    // A layout this version doesn't read, with its staging file beside the destination.
    const laterId = '00000000-0000-4000-8000-000000000005'
    const staging = join(dirs.dest, 'other.iso.sonic')
    await manifest(laterId, {
      version: 5,
      partialPath: staging,
      state: { id: laterId, destinationPath: join(dirs.dest, 'other.iso'), status: 'paused' }
    })
    await writeFile(staging, seededBytes(1000, 6))

    // An old manifest naming a file that holds something: never Sonic's to delete.
    const realId = '00000000-0000-4000-8000-000000000003'
    const realFile = join(dirs.dest, 'mine.txt')
    await manifest(realId, {
      version: 2,
      state: { id: realId, destinationPath: realFile, status: 'paused' }
    })
    await writeFile(realFile, 'keep me')

    await sonic.launch()
    expect((await sonic.currentHttp())?.id).toBe(id)
    for (const kept of [join(root, oldId), placeholder, join(root, laterId), staging]) {
      await expect.poll(() => existsSync(kept), { message: `${kept} preserved` }).toBe(true)
    }
    await expect.poll(() => existsSync(join(root, realId))).toBe(true)
    expect(await readFile(realFile, 'utf-8')).toBe('keep me')
    // These fixtures live only in this test's temporary userData/destination directories.
    await Promise.all([
      rm(join(root, oldId), { recursive: true, force: true }),
      rm(placeholder, { force: true }),
      rm(join(root, laterId), { recursive: true, force: true }),
      rm(staging, { force: true }),
      rm(join(root, realId), { recursive: true, force: true }),
      rm(realFile, { force: true })
    ])

    await sonic.api.resumeDownload(id)
    await sonic.waitForHttpStatus('completed')
  })

  test('a staging file cut short while the app was closed is fetched again', async ({
    sonic,
    serve
  }) => {
    // What a power cut can do: the manifest says a block is done, but its data never all
    // reached the disk.
    const { id } = await pausedDownload(sonic, serve)
    const state = (await sonic.currentHttp())!
    const done = state.blocks!.find((block) => block.status === 'completed')!
    await sonic.quit()
    const staging = `${state.destinationPath}.sonic`
    await truncate(staging, done.rangeStart + 1000)

    await sonic.launch()
    await sonic.api.resumeDownload(id)
    await sonic.waitForHttpStatus('completed')
  })
})
