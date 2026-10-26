import { electronApp, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, Menu, nativeTheme, Notification, shell, Tray } from 'electron'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { testKnobs } from './testKnobs'
import { currentBrandIcon, registerBrandTray, setBrandTheme } from './appBranding'
import {
  getSonicThemeSource,
  registerSonicBridge,
  startHeadlessRemoteControl,
  stopSonicBridge,
  waitForSonicBackend
} from './sonicBridge'
import { acceptedLink, bringForward, linkFromArgs, offerLink } from './openLinks'
import { installRuntimeLogCapture } from './runtimeLog'
import { loadSettings } from './settings'
import { checkForUpdate } from './updater'
import {
  UPDATE_PUBLISHER_KEY_FINGERPRINT,
  UPDATE_PUBLISHER_PUBLIC_KEY_PEM
} from './updateTrust.generated'

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

app.setName('Sonic')
const appDataDir = app.getPath('appData')
const legacyUserDataDir = join(appDataDir, "Speed-o'-Freq Sonic")
// An explicit isolated profile is useful for acceptance-testing a fresh packaged build alongside
// an existing Sonic session without sharing its single-instance lock or touching its downloads.
const isolatedUserDataDir = process.env['SONIC_ISOLATED_USER_DATA_DIR']
if (isolatedUserDataDir) app.setPath('userData', resolve(isolatedUserDataDir))
else if (existsSync(legacyUserDataDir)) app.setPath('userData', legacyUserDataDir)
else if (testKnobs.userDataDir && !app.isPackaged) app.setPath('userData', testKnobs.userDataDir)
const headlessMode = process.argv.includes('--headless')
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quittingFromTray = false

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

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_UPDATE_REPOSITORY = 'S0L0-R00T-DEV/Sonic'
let lastNotifiedUpdateVersion: string | null = null

async function checkForUpdatesInBackground(): Promise<void> {
  try {
    const settings = await loadSettings()
    const result = await checkForUpdate(
      settings.updateRepository ?? DEFAULT_UPDATE_REPOSITORY,
      UPDATE_PUBLISHER_PUBLIC_KEY_PEM || settings.publisherPublicKeyPem,
      UPDATE_PUBLISHER_KEY_FINGERPRINT || settings.publisherKeyFingerprint
    )
    if (!result.updateAvailable || !result.latestVersion || !result.releaseUrl) return
    const openWindow = mainWindow
    if (openWindow && !openWindow.isDestroyed()) {
      const notifyRenderer = (): void => {
        if (!openWindow.isDestroyed()) openWindow.webContents.send('updater:detected', result.latestVersion)
      }
      if (openWindow.webContents.isLoading()) openWindow.webContents.once('did-finish-load', notifyRenderer)
      else notifyRenderer()
    }
    if (lastNotifiedUpdateVersion === result.latestVersion) return
    lastNotifiedUpdateVersion = result.latestVersion
    if (!Notification.isSupported()) return
    const body = result.verificationError
      ? `Version ${result.latestVersion} is available. Open Sonic → About to review update verification.`
      : `Version ${result.latestVersion} is available. Open Sonic → About to review and install it.`
    const notification = new Notification({ title: 'Sonic update available', body })
    notification.on('click', () => {
      showMainWindow()
      const target = mainWindow
      if (!target || target.isDestroyed()) return
      const notifyRenderer = (): void => {
        if (!target.isDestroyed())
          target.webContents.send('updater:available', result.latestVersion)
      }
      if (target.webContents.isLoading()) target.webContents.once('did-finish-load', notifyRenderer)
      else notifyRenderer()
    })
    notification.show()
  } catch (error) {
    console.warn('[Sonic updater] background update check failed:', error)
  }
}

function ensureTray(): void {
  if (tray) return
  tray = new Tray(currentBrandIcon())
  tray.setToolTip('Sonic')
  registerBrandTray(tray)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Sonic', click: showMainWindow },
      { type: 'separator' },
      {
        label: 'Exit Sonic',
        click: () => {
          quittingFromTray = true
          tray?.destroy()
          tray = null
          app.quit()
        }
      }
    ])
  )
  tray.on('double-click', showMainWindow)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 720,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    title: 'Sonic',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#050505' : '#fffdf5',
    ...(process.platform !== 'darwin' ? { icon: currentBrandIcon() } : {}),
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 9 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.on('ready-to-show', () => {
    mainWindow?.setIcon(currentBrandIcon())
    mainWindow?.show()
  })
  mainWindow.on('close', (event) => {
    if (quittingFromTray) return
    event.preventDefault()
    mainWindow?.hide()
    ensureTray()
  })
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
  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  if (!hasInstanceLock) return
  electronApp.setAppUserModelId('com.speedofreq.sonic')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  await registerSonicBridge()
  setBrandTheme()
  nativeTheme.themeSource = getSonicThemeSource() === 'light' ? 'light' : 'dark'
  // Keep the desktop UI responsive even when the download backend is slow or unavailable.
  // Headless remote-control startup still waits for the backend below before enabling its listener.
  if (!headlessMode) createWindow()
  // Background checks only notify; they never download or install an update automatically.
  if (!headlessMode) {
    const updateTimer = setInterval(
      () => void checkForUpdatesInBackground(),
      UPDATE_CHECK_INTERVAL_MS
    )
    updateTimer.unref()
    setTimeout(() => void checkForUpdatesInBackground(), 15000).unref()
  }
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
  nativeTheme.on('updated', () => {
    mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#050505' : '#fffdf5')
  })
  app.on('activate', () => {
    if (!headlessMode && BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  // Explicit app.quit() (including OS shutdown and automated tests) must bypass the close-to-tray
  // handler; otherwise Electron hides the window again and never finishes quitting.
  quittingFromTray = true
  tray?.destroy()
  tray = null
  stopSonicBridge()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) app.quit()
})
