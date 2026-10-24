import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('settings expose storage information and backup controls', async ({ sonic, dirs }) => {
  const info = await sonic.api.getStorageInfo()
  expect(info.userDataDir).toBe(dirs.userData)
  expect(typeof info.portable).toBe('boolean')

  await sonic.page.getByRole('button', { name: 'Open settings' }).click()
  await expect(sonic.page.getByRole('heading', { name: 'Backup and storage' })).toBeVisible()
  await expect(sonic.page.getByRole('button', { name: 'Export backup' })).toBeVisible()
  await expect(sonic.page.getByRole('button', { name: 'Restore backup' })).toBeVisible()
  await expect(sonic.page.getByRole('button', { name: 'Choose portable folder' })).toBeVisible()
})

test('exported backup includes settings, history, queue manifests and media manifests', async ({
  sonic,
  dirs
}) => {
  const taskId = '11111111-1111-4111-8111-111111111111'
  const mediaId = '22222222-2222-4222-8222-222222222222'
  await writeFile(join(dirs.userData, 'app-settings.json'), JSON.stringify({ speedLimit: 12345 }))
  await writeFile(join(dirs.userData, 'history.json'), JSON.stringify({ version: 1, entries: [] }))
  const taskRoot = join(dirs.userData, 'downloads', taskId)
  await mkdir(taskRoot, { recursive: true })
  await writeFile(
    join(taskRoot, 'manifest.json'),
    JSON.stringify({ version: 7, state: { id: taskId }, requestPayload: { kind: 'http' } })
  )
  const mediaRoot = join(dirs.userData, 'media-downloads')
  await mkdir(mediaRoot, { recursive: true })
  await writeFile(join(mediaRoot, mediaId + '.json'), JSON.stringify({ version: 1, id: mediaId }))

  const backupPath = join(dirs.dest, 'sonic-test-backup.json')
  await sonic.evaluateMain((_electron, path) => {
    _electron.dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: path
    })) as typeof _electron.dialog.showSaveDialog
  }, backupPath)

  expect(await sonic.api.exportStorageBackup()).toBe(true)
  const backup = JSON.parse(await readFile(backupPath, 'utf8')) as {
    format: string
    version: number
    files: { name: string; content: string }[]
    tasks: { id: string }[]
    mediaTasks: { name: string }[]
  }
  expect(backup.format).toBe('speed-o-freq-sonic-backup')
  expect(backup.version).toBe(1)
  expect(backup.files.some((file) => file.name === 'app-settings.json')).toBe(true)
  expect(backup.files.some((file) => file.name === 'history.json')).toBe(true)
  expect(backup.tasks.some((task) => task.id === taskId)).toBe(true)
  expect(backup.mediaTasks.some((task) => task.name === mediaId + '.json')).toBe(true)
})

test('restore merges backup state and restores missing queue and media manifests', async ({
  sonic,
  dirs
}) => {
  const taskId = '33333333-3333-4333-8333-333333333333'
  const mediaId = '44444444-4444-4444-8444-444444444444'
  const taskManifest = JSON.stringify({
    version: 7,
    state: { id: taskId },
    requestPayload: { kind: 'http' }
  })
  const mediaManifest = JSON.stringify({ version: 1, id: mediaId })
  const backupPath = join(dirs.dest, 'sonic-restore-backup.json')
  await writeFile(
    backupPath,
    JSON.stringify({
      format: 'speed-o-freq-sonic-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      appVersion: 'test',
      files: [
        { name: 'app-settings.json', content: JSON.stringify({ speedLimit: 12345 }) },
        { name: 'history.json', content: JSON.stringify({ version: 1, entries: [] }) }
      ],
      tasks: [{ id: taskId, manifest: taskManifest }],
      mediaTasks: [{ name: mediaId + '.json', content: mediaManifest }]
    })
  )

  await sonic.evaluateMain((_electron, path) => {
    const runtime = globalThis as typeof globalThis & {
      __sonicStorageRestoreOriginals?: {
        showOpenDialog: typeof _electron.dialog.showOpenDialog
        showMessageBox: typeof _electron.dialog.showMessageBox
        relaunch: typeof _electron.app.relaunch
        exit: typeof _electron.app.exit
      }
    }
    runtime.__sonicStorageRestoreOriginals = {
      showOpenDialog: _electron.dialog.showOpenDialog,
      showMessageBox: _electron.dialog.showMessageBox,
      relaunch: _electron.app.relaunch,
      exit: _electron.app.exit
    }
    _electron.dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path]
    })) as typeof _electron.dialog.showOpenDialog
    _electron.dialog.showMessageBox = (async () => ({
      response: 0,
      checkboxChecked: false
    })) as unknown as typeof _electron.dialog.showMessageBox
    _electron.app.relaunch = (() => undefined) as typeof _electron.app.relaunch
    _electron.app.exit = (() => undefined) as typeof _electron.app.exit
  }, backupPath)

  try {
    const result = await sonic.api.restoreStorageBackup()
    expect(result).toMatchObject({
      settingsRestored: true,
      historyEntries: 0,
      tasksRestored: 1,
      mediaTasksRestored: 1
    })
    expect(
      JSON.parse(await readFile(join(dirs.userData, 'app-settings.json'), 'utf8')).speedLimit
    ).toBe(12345)
    expect(await readFile(join(dirs.userData, 'downloads', taskId, 'manifest.json'), 'utf8')).toBe(
      taskManifest
    )
    expect(await readFile(join(dirs.userData, 'media-downloads', mediaId + '.json'), 'utf8')).toBe(
      mediaManifest
    )
    expect(
      (await readdir(dirs.userData)).some((name) => name.startsWith('pre-restore-backup-'))
    ).toBe(true)
  } finally {
    await sonic.evaluateMain((_electron) => {
      const runtime = globalThis as typeof globalThis & {
        __sonicStorageRestoreOriginals?: {
          showOpenDialog: typeof _electron.dialog.showOpenDialog
          showMessageBox: typeof _electron.dialog.showMessageBox
          relaunch: typeof _electron.app.relaunch
          exit: typeof _electron.app.exit
        }
      }
      const originals = runtime.__sonicStorageRestoreOriginals
      if (originals) {
        _electron.dialog.showOpenDialog = originals.showOpenDialog
        _electron.dialog.showMessageBox = originals.showMessageBox
        _electron.app.relaunch = originals.relaunch
        _electron.app.exit = originals.exit
        delete runtime.__sonicStorageRestoreOriginals
      }
    }, null)
  }
})

test('portable storage copies user data to an empty chosen folder before restart', async ({
  sonic,
  dirs
}) => {
  const portableDir = join(dirs.dest, 'portable-store')
  const appDataDir = join(dirs.dest, 'mock-appdata')
  await writeFile(join(dirs.userData, 'portable-fixture.txt'), 'preserve-me', 'utf8')

  await sonic.evaluateMain(
    (_electron, args) => {
      const runtime = globalThis as typeof globalThis & {
        __sonicPortableOriginals?: {
          showOpenDialog: typeof _electron.dialog.showOpenDialog
          showMessageBox: typeof _electron.dialog.showMessageBox
          relaunch: typeof _electron.app.relaunch
          exit: typeof _electron.app.exit
          getPath: typeof _electron.app.getPath
        }
      }
      runtime.__sonicPortableOriginals = {
        showOpenDialog: _electron.dialog.showOpenDialog,
        showMessageBox: _electron.dialog.showMessageBox,
        relaunch: _electron.app.relaunch,
        exit: _electron.app.exit,
        getPath: _electron.app.getPath
      }
      _electron.app.getPath = ((name: Parameters<typeof _electron.app.getPath>[0]) =>
        name === 'appData'
          ? args.appDataDir
          : runtime.__sonicPortableOriginals!.getPath.call(
              _electron.app,
              name
            )) as typeof _electron.app.getPath
      _electron.dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [args.portableDir]
      })) as typeof _electron.dialog.showOpenDialog
      _electron.dialog.showMessageBox = (async () => ({
        response: 0,
        checkboxChecked: false
      })) as unknown as typeof _electron.dialog.showMessageBox
      _electron.app.relaunch = (() => undefined) as typeof _electron.app.relaunch
      _electron.app.exit = (() => undefined) as typeof _electron.app.exit
    },
    { portableDir, appDataDir }
  )

  try {
    expect(await sonic.api.configurePortableStorage()).toBe(portableDir)
    expect(await readFile(join(portableDir, 'portable-fixture.txt'), 'utf8')).toBe('preserve-me')
    const marker = join(appDataDir, "Speed-o'-Freq Sonic", 'portable-mode.json')
    expect(JSON.parse(await readFile(marker, 'utf8')).userDataDir).toBe(portableDir)
  } finally {
    await sonic.evaluateMain((_electron) => {
      const runtime = globalThis as typeof globalThis & {
        __sonicPortableOriginals?: {
          showOpenDialog: typeof _electron.dialog.showOpenDialog
          showMessageBox: typeof _electron.dialog.showMessageBox
          relaunch: typeof _electron.app.relaunch
          exit: typeof _electron.app.exit
          getPath: typeof _electron.app.getPath
        }
      }
      const originals = runtime.__sonicPortableOriginals
      if (originals) {
        _electron.dialog.showOpenDialog = originals.showOpenDialog
        _electron.dialog.showMessageBox = originals.showMessageBox
        _electron.app.relaunch = originals.relaunch
        _electron.app.exit = originals.exit
        _electron.app.getPath = originals.getPath
        delete runtime.__sonicPortableOriginals
      }
    }, null)
    await rm(appDataDir, { recursive: true, force: true })
    await rm(portableDir, { recursive: true, force: true })
  }
})
