import { electronApp, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron'
import { join, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { testKnobs } from './testKnobs'
import icon from '../../resources/icon-dark.png?asset'
import {
  getSonicThemeSource,
  registerSonicBridge,
  startHeadlessRemoteControl,
  stopSonicBridge,
  waitForSonicBackend
} from './sonicBridge'
import { acceptedLink, bringForward, linkFromArgs, offerLink } from './openLinks'
import { installRuntimeLogCapture } from './runtimeLog'

// Keep a bounded, redacted in-memory log for user-triggered diagnostic exports.
installRuntimeLogCapture()

// Prevent Chromium GPU compositing from leaving a persistent black window surface on some Windows drivers.
// E2E-only opt-in lets us compare GPU compositing without changing packaged release behavior.
const e2eGpuEnabled = !app.isPackaged && process.env['SONIC_E2E_GPU'] === '1'
if (e2eGpuEnabled) {
  const scaleFactor = Number(process.env['SONIC_E2E_DEVICE_SCALE_FACTOR'])
  if ([1, 1.25, 1.5, 1.75, 2].includes(scaleFactor)) {
    app.commandLine.appendSwitch('force-device-scale-factor', String(scaleFactor))
  }
} else {
  app.disableHardwareAcceleration()
}

app.setName("Speed-o'-Freq Sonic")
// Portable mode is opt-in and points userData at a user-selected writable folder. The selector
// lives under appData so installed builds need not write into Program Files.
if (testKnobs.userDataDir && !app.isPackaged) app.setPath('userData', testKnobs.userDataDir)
else {
  try {
    const marker = join(app.getPath('appData'), "Speed-o'-Freq Sonic", 'portable-mode.json')
    const config = JSON.parse(readFileSync(marker, 'utf8')) as {
      version?: number
      userDataDir?: unknown
    }
    if (
      config.version === 1 &&
      typeof config.userDataDir === 'string' &&
      existsSync(resolve(config.userDataDir))
    ) {
      app.setPath('userData', resolve(config.userDataDir))
    }
  } catch {
    /* First launch or portable mode is not configured. */
  }
}
const headlessMode = process.argv.includes('--headless')
let mainWindow: BrowserWindow | null = null

const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()
else {
  app.on('second-instance', (_event, argv) => {
    const link = linkFromArgs(argv)
    if (link) offerLink({ url: link, from: 'command line' }, mainWindow)
    else if (mainWindow && !mainWindow.isDestroyed()) bringForward(mainWindow)
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    const link = acceptedLink(url)
    if (link) offerLink({ url: link, from: 'browser' }, mainWindow)
  })
  app.on('open-file', (event, path) => {
    event.preventDefault()
    const link = acceptedLink(path)
    if (link) offerLink({ url: link, from: 'file manager' }, mainWindow)
  })
  const startupLink = linkFromArgs(process.argv)
  if (startupLink) offerLink({ url: startupLink, from: 'command line' }, null)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 720,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    title: "Speed-o'-Freq Sonic",
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#050505' : '#fffdf5',
    ...(process.platform !== 'darwin' ? { icon } : {}),
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 9 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('context-menu', (_, { isEditable, selectionText, editFlags }) => {
    const template: Electron.MenuItemConstructorOptions[] = isEditable
      ? [
          { role: 'cut', enabled: editFlags.canCut },
          { role: 'copy', enabled: editFlags.canCopy },
          { role: 'paste', enabled: editFlags.canPaste },
          { type: 'separator' },
          { role: 'selectAll', enabled: editFlags.canSelectAll }
        ]
      : selectionText.trim()
        ? [{ role: 'copy' }]
        : []
    if (template.length) Menu.buildFromTemplate(template).popup()
  })
  if (process.env['ELECTRON_RENDERER_URL'])
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  if (!hasInstanceLock) return
  electronApp.setAppUserModelId('com.speedofreq.sonic')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  await registerSonicBridge()
  nativeTheme.themeSource = getSonicThemeSource()
  let backendReady = true
  await waitForSonicBackend().catch((error) => {
    backendReady = false
    console.error('[Sonic bridge] backend startup failed:', error)
  })
  if (headlessMode && process.argv.includes('--remote-control')) {
    if (!backendReady) {
      console.error(
        '[Sonic remote] headless startup aborted because the download backend is unavailable.'
      )
      app.quit()
      return
    }
    const interfaceFlag = process.argv.indexOf('--interface')
    const interfaceId = interfaceFlag >= 0 ? process.argv[interfaceFlag + 1] : undefined
    try {
      await startHeadlessRemoteControl(interfaceId)
      console.info('[Sonic remote] headless local-Wi-Fi control enabled')
    } catch (error) {
      console.error(
        '[Sonic remote] headless startup failed; remote listener was not enabled:',
        error
      )
      app.quit()
      return
    }
  }
  if (!headlessMode) createWindow()
  nativeTheme.on('updated', () => {
    mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#050505' : '#fffdf5')
  })
  app.on('activate', () => {
    if (!headlessMode && BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => stopSonicBridge())
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
