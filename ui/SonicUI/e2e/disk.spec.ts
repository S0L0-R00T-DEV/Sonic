import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BLOCK, expect, SonicApp, test } from './fixtures'

// E. The disk: out of space, folders vanishing, no permission. The small volumes are real
// filesystems (a RAM disk on macOS, tmpfs on Linux), so ENOSPC comes from the OS, not a mock.

interface Volume {
  path: string
  dispose: () => Promise<void>
}

/** A real filesystem of `megabytes` size, or null where one can't be made without a password. */
async function smallVolume(megabytes: number): Promise<Volume | null> {
  try {
    if (process.platform === 'darwin') {
      const name = `sonice2e${process.pid}${Date.now() % 100000}`
      const device = execFileSync('hdiutil', ['attach', '-nomount', `ram://${megabytes * 2048}`])
        .toString()
        .trim()
      execFileSync('diskutil', ['erasevolume', 'HFS+', name, device], { stdio: 'ignore' })
      return {
        path: `/Volumes/${name}`,
        dispose: async () => {
          execFileSync('hdiutil', ['detach', device, '-force'], { stdio: 'ignore' })
        }
      }
    }
    if (process.platform === 'linux') {
      const path = await mkdtemp(join(tmpdir(), 'sonic-vol-'))
      execFileSync('sudo', [
        '-n',
        'mount',
        '-t',
        'tmpfs',
        '-o',
        `size=${megabytes}m`,
        'tmpfs',
        path
      ])
      execFileSync('sudo', ['-n', 'chown', String(process.getuid?.()), path])
      return {
        path,
        dispose: async () => {
          execFileSync('sudo', ['-n', 'umount', path])
          await rm(path, { recursive: true, force: true })
        }
      }
    }
  } catch {
    // No RAM disk tools, or no passwordless sudo — the test skips itself.
  }
  return null
}

test.describe('disk space @disk', () => {
  test('a file bigger than the free space is refused before anything is written', async ({
    sonic,
    serve,
    dirs
  }) => {
    const volume = await smallVolume(10)
    test.skip(!volume, 'cannot create a small volume on this machine')
    try {
      const dest = join(volume!.path, 'dest')
      await mkdir(dest)
      const origin = await serve({ size: 256 * BLOCK }) // 16 MB
      await expect(
        sonic.start(origin.url(), origin.sha256, { destinationDir: dest })
      ).rejects.toThrow(/Not enough disk space/)
      expect(await readdir(dest)).toEqual([])
      const downloads = join(dirs.userData, 'downloads')
      expect(existsSync(downloads) ? await readdir(downloads) : []).toEqual([])
    } finally {
      await sonic.quit()
      await volume!.dispose()
    }
  })

  test('a file that fits once but not twice completes on the destination volume', async ({
    serve
  }) => {
    const volume = await smallVolume(40)
    test.skip(!volume, 'cannot create a small volume on this machine')
    // Both metadata and destination are on the small volume; the payload must occupy only one copy.
    // Room is left for Chromium's own caches in userData, which take several MB at launch.
    const app = new SonicApp({
      userData: join(volume!.path, 'userData'),
      dest: join(volume!.path, 'dest')
    })
    try {
      await mkdir(app.dirs.userData)
      await mkdir(app.dirs.dest)
      await app.launch()
      const origin = await serve({ size: 384 * BLOCK }) // 24 MB: fits once, not twice
      await app.start(origin.url(), origin.sha256)
      const done = await app.waitForStatus('completed')
      expect(await readdir(app.dirs.dest)).toEqual([done.fileName])
    } finally {
      if (app.alive) await app.kill()
      await volume!.dispose()
    }
  })
})

test.describe('destination folder problems @smoke', () => {
  // Also tests a destination write error: the staging file cannot be opened, and cleanup must
  // surface that instead of waiting forever for a 'drain' that never comes.
  test('destination folder deleted mid-download → error, nothing left', async ({
    sonic,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: 24 * BLOCK })
    const reached = origin.hold(10 * BLOCK)
    await sonic.start(origin.url(), origin.sha256)
    await reached
    await rm(dirs.dest, { recursive: true, force: true })
    origin.release()
    const state = await sonic.waitForStatus(['completed', 'error'])
    expect(state.status).toBe('error')
  })

  test('read-only destination folder → refused, and nothing left in userData', async ({
    sonic,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: 4 * BLOCK })
    const windowsUser =
      process.platform === 'win32' ? execFileSync('whoami').toString().trim() : null
    if (windowsUser) {
      // chmod is advisory on Windows; deny directory write access through a real NTFS ACL.
      execFileSync('icacls', [dirs.dest, '/deny', `${windowsUser}:(W)`], { stdio: 'ignore' })
    } else {
      await chmod(dirs.dest, 0o555)
    }
    try {
      await expect(sonic.start(origin.url(), origin.sha256)).rejects.toThrow(
        /EACCES|EPERM|permission/i
      )
      const downloads = join(dirs.userData, 'downloads')
      expect(
        existsSync(downloads) ? await readdir(downloads) : [],
        'no orphaned parts folder from the refused start'
      ).toEqual([])
    } finally {
      if (windowsUser) {
        execFileSync('icacls', [dirs.dest, '/remove:d', windowsUser], { stdio: 'ignore' })
      } else {
        await chmod(dirs.dest, 0o755)
      }
    }
  })
})

test.describe('publication rename failure @smoke', () => {
  test.use({ appEnv: { SONIC_E2E_PUBLISH_RENAME_ERROR: 'EACCES' } })

  test('a failed publication keeps the complete staging file and can be retried', async ({
    sonic,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: 4 * BLOCK, seed: 91 })
    const id = await sonic.start(origin.url(), origin.sha256)
    const failed = await sonic.waitForHttpStatus('error', 20_000)
    expect(failed.error).toMatch(/publication rename failure.*EACCES/i)
    expect(existsSync(failed.destinationPath)).toBe(false)
    expect(existsSync(`${failed.destinationPath}.sonic`)).toBe(true)

    const manifestPath = join(dirs.userData, 'downloads', id, 'manifest.json')
    const saved = JSON.parse(
      await (await import('node:fs/promises')).readFile(manifestPath, 'utf8')
    )
    expect(saved.state).toMatchObject({ status: 'error', error: failed.error })
    expect(saved.publicationPath).toBe(failed.destinationPath)

    await sonic.evaluateMain(() => {
      delete process.env.SONIC_E2E_PUBLISH_RENAME_ERROR
    }, null)
    await sonic.api.resumeDownload(id)
    const completed = await sonic.waitForHttpStatus('completed', 20_000)
    expect(await (await import('node:fs/promises')).readFile(completed.destinationPath)).toEqual(
      origin.content
    )
    expect(existsSync(`${completed.destinationPath}.sonic`)).toBe(false)
  })
})

test('EACCES during a range write keeps the staged download resumable @smoke', async ({
  sonic,
  serve
}) => {
  type OriginalWrites = {
    write: typeof import('node:fs').write
    writev: typeof import('node:fs').writev
  }

  await sonic.evaluateMain(() => {
    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    const runtime = globalThis as typeof globalThis & { __sonicEaccesOriginalFs?: OriginalWrites }
    runtime.__sonicEaccesOriginalFs = { write: fs.write, writev: fs.writev }
    fs.write = ((_fd, buffer, _offset, _length, _position, callback) => {
      const error = Object.assign(new Error('Permission denied'), { code: 'EACCES' })
      callback(error, 0, buffer)
    }) as typeof fs.write
    fs.writev = ((_fd, buffers, _position, callback) => {
      const error = Object.assign(new Error('Permission denied'), { code: 'EACCES' })
      callback(error, 0, buffers)
    }) as typeof fs.writev
  }, null)

  const restoreWriter = async (): Promise<void> => {
    await sonic.evaluateMain(() => {
      const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
      const runtime = globalThis as typeof globalThis & { __sonicEaccesOriginalFs?: OriginalWrites }
      if (runtime.__sonicEaccesOriginalFs) {
        fs.write = runtime.__sonicEaccesOriginalFs.write
        fs.writev = runtime.__sonicEaccesOriginalFs.writev
        delete runtime.__sonicEaccesOriginalFs
      }
    }, null)
  }

  const origin = await serve({ size: 24 * BLOCK, seed: 24 })
  const id = await sonic.start(origin.url(), origin.sha256)
  try {
    const failed = await sonic.waitForHttpStatus('error', 25_000)
    expect(failed.error).toMatch(/EACCES|Permission denied/i)
    expect(existsSync(failed.destinationPath)).toBe(false)
    expect(existsSync(`${failed.destinationPath}.sonic`)).toBe(true)
  } finally {
    await restoreWriter()
  }

  await sonic.api.resumeDownload(id)
  const complete = await sonic.waitForHttpStatus('completed', 30_000)
  expect(existsSync(complete.destinationPath)).toBe(true)
})

test('ENOSPC during a range write keeps the staged download resumable @smoke', async ({
  sonic,
  serve
}) => {
  type OriginalWrites = {
    write: typeof import('node:fs').write
    writev: typeof import('node:fs').writev
  }

  const patched = await sonic.evaluateMain(() => {
    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    const runtime = globalThis as typeof globalThis & { __sonicEnospcOriginalFs?: OriginalWrites }
    runtime.__sonicEnospcOriginalFs = { write: fs.write, writev: fs.writev }
    fs.write = ((_fd, buffer, _offset, _length, _position, callback) => {
      const error = Object.assign(new Error('No space left on device'), { code: 'ENOSPC' })
      callback(error, 0, buffer)
    }) as typeof fs.write
    fs.writev = ((_fd, buffers, _position, callback) => {
      const error = Object.assign(new Error('No space left on device'), { code: 'ENOSPC' })
      callback(error, 0, buffers)
    }) as typeof fs.writev
    return true
  }, null)
  expect(patched).toBe(true)

  const restoreWriter = async (): Promise<void> => {
    await sonic.evaluateMain(() => {
      const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
      const runtime = globalThis as typeof globalThis & { __sonicEnospcOriginalFs?: OriginalWrites }
      if (runtime.__sonicEnospcOriginalFs) {
        fs.write = runtime.__sonicEnospcOriginalFs.write
        fs.writev = runtime.__sonicEnospcOriginalFs.writev
        delete runtime.__sonicEnospcOriginalFs
      }
    }, null)
  }

  const origin = await serve({ size: 24 * BLOCK, seed: 23 })
  const id = await sonic.start(origin.url(), origin.sha256)
  try {
    const failed = await sonic.waitForHttpStatus('error', 25_000)
    expect(failed.error).toMatch(/ENOSPC|No space left on device/i)
    expect(existsSync(failed.destinationPath)).toBe(false)
    expect(existsSync(`${failed.destinationPath}.sonic`)).toBe(true)
  } finally {
    await restoreWriter()
  }

  await sonic.api.resumeDownload(id)
  const complete = await sonic.waitForHttpStatus('completed', 30_000)
  expect(existsSync(complete.destinationPath)).toBe(true)
})
