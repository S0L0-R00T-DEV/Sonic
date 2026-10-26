import {
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
  shell,
  BrowserWindow
} from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { instancePipeSuffix } from './instancePipe'
import { connect, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { existsSync, statSync } from 'node:fs'
import { copyFile, readFile, statfs, writeFile } from 'node:fs/promises'
import { join, basename, dirname, resolve } from 'node:path'
import { IpcChannels as C } from '../shared/ipc-channels'
import type {
  DownloadUpdate,
  FinishedDownload,
  HttpDownloadState,
  HttpBlockState,
  NetworkInterfaceInfo,
  ProbeResult,
  StartDownloadRequest,
  SiteMirrorRequest,
  SiteMirrorPreview,
  SiteMirrorProgressEvent,
  AppSettings,
  InitialState,
  ThemeSource
} from '../shared/types'
import { loadSettings, saveSettings } from './settings'
import { setBrandTheme } from './appBranding'
import { scheduleWindow } from '../shared/downloadSchedule'
import { startBridge } from './browserBridge'
import { testInterfaces } from './testKnobs'
import { offerLink, pendingLink, pendingLinks, releaseLink } from './openLinks'
import { DownloadManager } from './download/downloadManager'
import { MediaDownloadManager } from './download/mediaDownloadManager'
import { MediaConversionManager, sha256File } from './download/mediaConversion'
import {
  fingerprintEd25519PublicKey,
  verifyFileSha256,
  verifySignedManifest
} from './download/integrityVerification'
import { checkForUpdate, downloadVerifiedUpdate, openVerifiedUpdate } from './updater'
import {
  UPDATE_PUBLISHER_KEY_FINGERPRINT,
  UPDATE_PUBLISHER_PUBLIC_KEY_PEM
} from './updateTrust.generated'
import { redactDiagnosticReport } from './diagnosticReport'
import { getRuntimeLogSnapshot } from './runtimeLog'
import { NetworkMonitor } from './network/interfaces'
import { probeUrl } from './download/probe'
import { previewSiteMirror } from './siteMirror'
import {
  addToHistory as addNativeHistory,
  listHistory as nativeHistory,
  markHistoryRemoved as markNativeHistoryRemoved,
  removeFromHistory as clearNativeHistory
} from './download/history'
import { startCliControlServer, stopCliControlServer } from './cliControl'
import {
  configureRemoteControl,
  createRemotePairingCode,
  disableRemoteControl,
  enableRemoteControl,
  exportRemoteCaCertificate,
  loadRemoteControlState,
  preferredRemoteInterfaceId,
  revokeRemoteDevice,
  stopRemoteControl
} from './remoteControlServer'
import { PluginRegistry } from './pluginRegistry'
import {
  createSettingsBackup,
  createHistoryBackup,
  isHistoryBackup,
  isSettingsBackup,
  restoreHistoryBackup,
  restoreSettingsBackup,
  restoreStorageBackup
} from './storageBackup'
import { DEFAULT_SLOW_MODE_SPEED, DOWNLOADS_AT_ONCE } from '../shared/types'

type QueueItem = {
  id: string
  url: string
  destination: string
  status: string
  createdAt?: string
  sourceAddresses?: string[] | null
  preferredSourceAddresses?: string[] | null
  networkPolicyPaused?: boolean
  bytesBySourceAddress?: Record<string, number>
  progressPercent?: number
  bytesDownloaded?: number
  wireBytesReceived?: number
  totalBytes?: number
  retries?: number
  speed?: string
  details?: string
  startedAt?: string
  finishedAt?: string
  elapsedSeconds?: number
  averageBytesPerSecond?: number
  peakBytesPerSecond?: number
}
type ControlResponse = {
  ok: boolean
  error?: string
  queue?: QueueItem[]
  usage?: Record<string, unknown>
}

let backend: ChildProcess | null = null
let poller: NodeJS.Timeout | null = null

function backendPipeName(): string {
  return `SpeedOFreqSonic.Control.v1${instancePipeSuffix()}`
}
let polling = false
let lastHistorySignature: string | null = null
const sequences = new Map<string, number>()
const DEFAULT_SETTINGS: AppSettings = {
  completionAction: 'notify',
  themeSource: 'sonic',
  downloadsAtOnce: DOWNLOADS_AT_ONCE.default,
  speedUnit: 'MB/s'
}
const settings: AppSettings = { ...DEFAULT_SETTINGS }
const downloadsDir = join(app.getPath('home'), 'Downloads')
let lastPolicySignature: string | null = null
let legacyBackendPolicyUnsupported = false
export function getSonicThemeSource(): ThemeSource {
  return settings.themeSource ?? 'sonic'
}
function backendExe(): string {
  const configured = process.env.SONIC_BACKEND_EXE
  if (configured && existsSync(configured)) return configured
  if (app.isPackaged) return join(process.resourcesPath, 'sonic-backend', 'SpeedOFreq.exe')
  return join(
    app.getAppPath(),
    '..',
    '..',
    'artifacts',
    'sonic-backend-current',
    'win-x64',
    'SpeedOFreq.exe'
  )
}
function ensureBackend(): void {
  if (backend && !backend.killed && backend.exitCode === null) return
  const exe = backendExe()
  if (!existsSync(exe))
    throw new Error('Sonic backend not found at ' + exe + '. Build the x64 backend package first.')
  const child = spawn(exe, ['--backend'], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, SONIC_BACKEND_PIPE: backendPipeName() }
  })
  backend = child
  // A previous child can exit after a replacement has already started. Only clear the shared
  // reference when the exiting child is still the one we own.
  const clearExitedBackend = (): void => {
    if (backend === child) backend = null
  }
  child.on('exit', clearExitedBackend)
  child.on('error', clearExitedBackend)
}
function controlOnce(payload: Record<string, unknown>): Promise<ControlResponse> {
  ensureBackend()
  return new Promise((resolve, reject) => {
    let socket: Socket
    try {
      socket = connect('\\\\.\\pipe\\' + backendPipeName())
    } catch (error) {
      reject(error)
      return
    }
    let buffer = ''
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('Timed out waiting for Sonic backend.'))
    }, 20000)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'))
    socket.on('data', (chunk) => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end < 0) return
      clearTimeout(timeout)
      socket.end()
      try {
        const result = JSON.parse(buffer.slice(0, end)) as ControlResponse
        if (!result.ok) reject(new Error(result.error || 'Sonic backend command failed.'))
        else resolve(result)
      } catch (error) {
        reject(error)
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}
async function control(payload: Record<string, unknown>): Promise<ControlResponse> {
  ensureBackend()
  let lastError: unknown
  for (let attempt = 0; attempt < 48; attempt++) {
    try {
      return await controlOnce(payload)
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      if (attempt === 47 || !['ENOENT', 'ECONNREFUSED', 'EBADF'].includes(code ?? '')) throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw lastError
}
function interfaces(): NetworkInterfaceInfo[] {
  // Keep the legacy queue/CLI interface view aligned with DownloadManager's network monitor.
  // In e2e runs this is important: the UI's selected IDs must match the fake interfaces supplied
  // to the native downloader (including an intentionally empty network list).
  const overridden = testInterfaces()
  if (overridden !== null) return overridden

  const result: NetworkInterfaceInfo[] = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    const usable = (entries ?? []).filter(
      (entry) => !entry.internal && (entry.family === 'IPv4' || entry.family === 'IPv6')
    )
    if (!usable.length) continue
    const kind = /wi-?fi|wireless|wlan/i.test(name)
      ? 'wifi'
      : /ethernet|eth|lan/i.test(name)
        ? 'ethernet'
        : /usb/i.test(name)
          ? 'usb'
          : 'other'
    result.push({
      id: name,
      device: name,
      displayName: name,
      kind,
      addresses: usable.map((entry) => {
        const family = entry.family === 'IPv4' ? 4 : 6
        const prefix = entry.cidr?.split('/')[1]
        return {
          address: entry.address,
          family,
          netmask: entry.netmask,
          ...(family === 4 && prefix
            ? { subnet: entry.address.split('.').slice(0, 3).join('.') }
            : {})
        }
      }),
      mac: usable[0]?.mac || undefined
    })
  }
  return result
}
function mapStatus(
  status: string
): 'queued' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled' {
  switch (status.toLowerCase()) {
    case 'running':
      return 'downloading'
    case 'paused':
      return 'paused'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'error'
    case 'canceled':
    case 'cancelled':
      return 'cancelled'
    default:
      return 'queued'
  }
}
function mapItem(item: QueueItem): DownloadUpdate {
  const idSeq = (sequences.get(item.id) ?? 0) + 1
  sequences.set(item.id, idSeq)
  const status = mapStatus(item.status)
  const totalBytes = Math.max(0, item.totalBytes ?? 0)
  const bytesDownloaded = Math.max(0, item.bytesDownloaded ?? 0)
  const speedBytesPerSec = Math.max(
    0,
    Number((item.speed ?? '').match(/[\d.]+/)?.[0] ?? 0) * 1_000_000
  )
  const startedAt = item.startedAt
    ? Date.parse(item.startedAt)
    : item.createdAt
      ? Date.parse(item.createdAt)
      : Date.now()
  const block: HttpBlockState = {
    kind: 'http',
    index: 0,
    status:
      status === 'completed' ? 'completed' : status === 'downloading' ? 'downloading' : 'pending',
    rangeStart: 0,
    rangeEnd: totalBytes || null,
    bytesDownloaded,
    bytesByInterface: {}
  }
  const knownInterfaces = interfaces()
  const networks = Object.entries(item.bytesBySourceAddress ?? {}).flatMap(
    ([sourceAddress, received]) => {
      const network = knownInterfaces.find((candidate) =>
        candidate.addresses.some((address) => address.address === sourceAddress)
      )
      return network && received > 0
        ? [
            {
              id: network.id,
              label: network.displayName,
              kind: network.kind,
              enabled: true,
              status: 'on' as const,
              bytesDownloaded: received,
              speedBytesPerSec: 0,
              retries: Math.max(0, item.retries ?? 0),
              transfer: 'http' as const
            }
          ]
        : []
    }
  )
  const state: Omit<HttpDownloadState, 'blocks'> = {
    kind: 'http',
    id: item.id,
    url: item.url,
    fileName: basename(item.destination),
    destinationPath: item.destination,
    totalBytes,
    bytesDownloaded,
    speedBytesPerSec,
    status,
    startedAt,
    queuedAt: item.createdAt ? Date.parse(item.createdAt) : startedAt,
    completedAt: item.finishedAt ? Date.parse(item.finishedAt) : undefined,
    error: status === 'error' || status === 'cancelled' ? item.details : undefined,
    resumable: status === 'error' || status === 'paused',
    timeLeftSeconds:
      speedBytesPerSec > 0 && totalBytes > bytesDownloaded
        ? (totalBytes - bytesDownloaded) / speedBytesPerSec
        : undefined,
    peakSpeedBytesPerSec: Math.max(0, item.peakBytesPerSecond ?? 0),
    seq: idSeq,
    networks,
    streams: [],
    peakStreams: 1,
    totalBlocks: totalBytes ? 1 : 0,
    blockSizeBytes: 4 * 1024 * 1024,
    diskLimited: false
  }
  return { seq: idSeq, state, blocks: totalBytes ? [block] : [] } as DownloadUpdate
}
function mapFinished(item: QueueItem): FinishedDownload {
  const update = mapItem(item)
  const state = update.state as HttpDownloadState
  const rest = { ...state }
  Reflect.deleteProperty(rest, 'blocks')
  Reflect.deleteProperty(rest, 'streams')
  return { ...rest, unitsWritten: item.status === 'Completed' ? 1 : 0 } as FinishedDownload
}
async function queue(): Promise<QueueItem[]> {
  const result = await control({ command: 'list' })
  return result.queue ?? []
}
function activeItems(items: QueueItem[]): QueueItem[] {
  return items.filter((item) => ['queued', 'running', 'paused'].includes(item.status.toLowerCase()))
}
function finishedItems(items: QueueItem[]): QueueItem[] {
  return items.filter(
    (item) => !['queued', 'running', 'paused'].includes(item.status.toLowerCase())
  )
}
function periodStartDate(period: 'day' | 'week' | 'month' = 'month'): string {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  if (period === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  else if (period === 'month') start.setDate(1)
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`
}

async function enforceNetworkDataLimits(items: QueueItem[]): Promise<void> {
  const allInterfaces = interfaces()
  const blockedAddresses = new Set<string>()
  for (const network of allInterfaces) {
    const preference = settings.networkPreferences?.[network.id]
    const limitBytes = preference?.dataLimit
    if (!limitBytes || limitBytes <= 0) continue
    const addresses = network.addresses
      .filter((address) => address.family === 4)
      .map((address) => address.address)
    if (addresses.length === 0) continue
    const startDate = periodStartDate(preference.dataLimitPeriod ?? 'month')
    const response = await control({
      command: 'network-usage',
      startDate,
      sourceAddresses: addresses
    })
    const used = addresses.reduce(
      (sum, address) => sum + Math.max(0, Number(response.usage?.[address] ?? 0)),
      0
    )
    if (used >= limitBytes) for (const address of addresses) blockedAddresses.add(address)
  }
  for (const item of items) {
    if (!['queued', 'running', 'paused'].includes(item.status.toLowerCase())) continue
    const preferred = item.preferredSourceAddresses ?? item.sourceAddresses
    if (preferred == null) continue // Unbound CLI-created items have no reliable adapter attribution.
    const desired = preferred.filter((address) => !blockedAddresses.has(address))
    const current = item.sourceAddresses ?? []
    if (
      desired.length === current.length &&
      desired.every((address, index) => address === current[index])
    )
      continue
    await control({
      command: 'set-networks',
      id: item.id,
      sourceAddresses: desired,
      policyLimited: true
    })
  }
}

async function emitSnapshot(): Promise<void> {
  if (polling || !app.isReady()) return
  polling = true
  try {
    const allowed = scheduleWindow(settings.downloadSchedule).allowed
    const downloadsAtOnce = settings.downloadsAtOnce ?? 2
    const speedLimitBytesPerSecond = settings.slowMode
      ? (settings.slowModeSpeed ?? DEFAULT_SLOW_MODE_SPEED)
      : undefined
    const networkSpeedLimits = interfaces().flatMap((network) => {
      const rate = settings.networkPreferences?.[network.id]?.speedLimit
      return rate && rate > 0
        ? network.addresses
            .filter((address) => address.family === 4)
            .map((address) => ({ sourceAddress: address.address, speedLimitBytesPerSecond: rate }))
        : []
    })
    const policySignature = JSON.stringify([
      allowed,
      downloadsAtOnce,
      speedLimitBytesPerSecond ?? 0,
      networkSpeedLimits
    ])
    if (policySignature !== lastPolicySignature) {
      if (!legacyBackendPolicyUnsupported) {
        try {
          await control({
            command: 'set-policy',
            allowed,
            downloadsAtOnce,
            speedLimitBytesPerSecond: speedLimitBytesPerSecond ?? 0,
            networkSpeedLimits
          })
        } catch (error) {
          // Older staged backend builds only support basic queue commands. New HTTP(S) and torrent
          // downloads use DownloadManager, where policy enforcement is fully implemented.
          if (/unsupported command/i.test(error instanceof Error ? error.message : String(error))) {
            legacyBackendPolicyUnsupported = true
          } else {
            throw error
          }
        }
      }
      lastPolicySignature = policySignature
    }
    let items = await queue()
    if (!legacyBackendPolicyUnsupported) await enforceNetworkDataLimits(items)
    items = await queue()
    const window = BrowserWindow.getAllWindows()[0]
    if (!window || window.isDestroyed()) return
    for (const item of activeItems(items)) window.webContents.send(C.downloadUpdated, mapItem(item))
    const signature = finishedItems(items)
      .map((item) => item.id + ':' + item.status + ':' + (item.finishedAt ?? ''))
      .join('|')
    if (signature !== lastHistorySignature) {
      lastHistorySignature = signature
      window.webContents.send(C.historyChanged)
    }
  } catch (error) {
    console.error('[Sonic bridge] queue poll failed:', error)
  } finally {
    polling = false
  }
}
function handle<Args extends unknown[], Result>(
  channel: string,
  fn: (...args: Args) => Result
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    // Privileged IPC is only for the application's own top-level renderer. Reject iframes and
    // other webContents before any handler can touch downloads, files, settings, or the CLI.
    const trustedWindow = BrowserWindow.getAllWindows().some(
      (window) => !window.isDestroyed() && window.webContents === event.sender
    )
    if (!trustedWindow || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
      throw new Error(`Rejected IPC request from an untrusted frame (${channel}).`)
    }
    return fn(...(args as Args))
  })
}
export async function registerSonicBridge(): Promise<void> {
  Object.assign(settings, await loadSettings())
  const mediaPolicyBlock = (currentSettings: AppSettings): string | undefined => {
    const dataLimitedNetwork = Object.values(currentSettings.networkPreferences ?? {}).some(
      (preference) => (preference.dataLimit ?? 0) > 0
    )
    if (dataLimitedNetwork) {
      return 'Waiting until per-network data limits are disabled; FFmpeg cannot attribute exact received bytes to a specific interface. Global, per-task, and configured per-network speed caps are applied conservatively through source-bitrate-based FFmpeg read-rate.'
    }
    return undefined
  }
  let onNetworkListChanged: () => void = () => undefined
  const torrentNetworks = new NetworkMonitor((list) => {
    onNetworkListChanged()
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed()) window.webContents.send(C.networksChanged, list)
  })
  const torrentManager = new DownloadManager(
    () => BrowserWindow.getAllWindows()[0] ?? null,
    torrentNetworks,
    () => settings.completionAction ?? 'notify'
  )
  onNetworkListChanged = () => torrentManager.networksChanged()
  // Prime the address snapshot even if the monitor's first poll completed before the manager
  // was constructed. Later changes wake streams immediately instead of waiting out backoff.
  void torrentNetworks
    .refresh()
    .then(() => torrentManager.networksChanged())
    .catch((error: unknown) => {
      console.warn('[Sonic bridge] could not refresh networks for download recovery:', error)
    })
  const pluginRegistry = new PluginRegistry()
  const siteMirrorControllers = new Map<string, AbortController>()
  const mediaConversionManager = new MediaConversionManager(
    () => BrowserWindow.getAllWindows()[0] ?? null
  )
  const mediaManager = new MediaDownloadManager(
    () => BrowserWindow.getAllWindows()[0] ?? null,
    () => settings.completionAction ?? 'notify',
    () => ({
      speedLimit: undefined,
      networkSpeedLimit: Math.min(
        ...Object.values(settings.networkPreferences ?? {})
          .map((preference) => preference.speedLimit)
          .filter((value): value is number => typeof value === 'number' && value > 0),
        Number.POSITIVE_INFINITY
      ),
      slowMode: settings.slowMode,
      slowModeSpeed: settings.slowModeSpeed
    })
  )
  await mediaManager.ready()
  let pumpingMediaQueue = false
  const pumpMediaQueue = async (): Promise<void> => {
    if (pumpingMediaQueue) return
    pumpingMediaQueue = true
    try {
      const currentSettings = settingsSnapshot()
      if (
        currentSettings.downloadSchedule?.enabled &&
        !scheduleWindow(currentSettings.downloadSchedule).allowed
      ) {
        await mediaManager.setQueuedReasonForAll(
          'Waiting for the scheduled download window to open.'
        )
        return
      }
      const policyBlock = mediaPolicyBlock(currentSettings)
      if (policyBlock) {
        await mediaManager.setQueuedReasonForAll(policyBlock)
        return
      }
      const [legacyItems, nativeItems] = await Promise.all([
        queue(),
        torrentManager.listDownloads()
      ])
      // Native and legacy queued items retain precedence; media joins behind them instead of
      // bypassing their queue. Count media/legacy transfers as external slots so the native
      // manager cannot fill the same slot concurrently.
      const activeLegacy = activeItems(legacyItems).map(mapItem)
      const mediaDownloads = mediaManager.listDownloads()
      const activeLegacyCount = activeLegacy.filter(
        (item) => item.state.status === 'downloading'
      ).length
      const activeMediaCount = mediaDownloads.filter(
        (item) => item.state.status === 'downloading'
      ).length
      torrentManager.setExternalRunningCount(activeLegacyCount + activeMediaCount)
      if (
        legacyItems.some((item) => item.status.toLowerCase() === 'queued') ||
        nativeItems.some((item) => item.state.status === 'queued')
      ) {
        await mediaManager.setQueuedReasonForAll(
          'Waiting for queued native/legacy downloads to start before media tasks.'
        )
        return
      }
      const activeCount =
        activeLegacyCount +
        nativeItems.filter((item) => item.state.status === 'downloading').length +
        activeMediaCount
      let slots = (currentSettings.downloadsAtOnce ?? DOWNLOADS_AT_ONCE.default) - activeCount
      if (slots <= 0) {
        await mediaManager.setQueuedReasonForAll('Waiting for a free download slot.')
        return
      }
      const waiting = mediaDownloads.filter((item) => item.state.status === 'queued')
      let started = 0
      for (const item of waiting.slice(0, slots)) {
        await mediaManager.startQueued(item.state.id)
        started++
        slots--
        torrentManager.setExternalRunningCount(activeLegacyCount + activeMediaCount + started)
      }
    } catch (error) {
      console.warn('[Sonic bridge] media queue pump failed:', error)
    } finally {
      pumpingMediaQueue = false
    }
  }
  const mediaQueueTimer = setInterval(() => void pumpMediaQueue(), 1000)
  mediaQueueTimer.unref()
  // The active Electron bridge owns the download manager. Keep the wake handler here (rather
  // than in the unused legacy IPC module) so long-lived HTTP/Torrent sockets are refreshed as
  // soon as the OS resumes, before their stall watchdogs expire.
  powerMonitor.on('resume', () => {
    torrentManager.systemResumed()
    void torrentNetworks.refresh()
  })
  // A normal window close must checkpoint in-flight work before Electron tears down the process.
  // Otherwise a fast quit can beat the 15-second routine checkpoint and lose resumable progress.
  let shutdownInProgress = false
  app.on('before-quit', (event) => {
    if (shutdownInProgress) return
    event.preventDefault()
    shutdownInProgress = true
    void torrentManager
      .suspendAll()
      .catch((error: unknown) => {
        console.error('[Sonic] Could not finish download checkpoints during shutdown:', error)
      })
      .finally(async () => {
        await mediaConversionManager.cancelAll().catch((error: unknown) => {
          console.error('[Sonic] Could not finish media conversion cleanup during shutdown:', error)
        })
        app.quit()
      })
  })
  const isNativeManaged = async (id: string): Promise<boolean> => {
    if ((await torrentManager.listDownloads()).some((entry) => entry.state.id === id)) return true
    return (await nativeHistory()).some((entry) => entry.id === id)
  }
  ipcMain.on(C.getInitialState, (event) => {
    const trustedWindow = BrowserWindow.getAllWindows().some(
      (window) => !window.isDestroyed() && window.webContents === event.sender
    )
    if (!trustedWindow || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
      console.warn('[Sonic bridge] rejected initial-state request from an untrusted frame')
      event.returnValue = null
      return
    }
    event.returnValue = {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      completionAction: settings.completionAction ?? 'notify',
      homeDir: app.getPath('home'),
      downloadsDir,
      themeSource: settings.themeSource ?? 'sonic',
      downloadSchedule: settings.downloadSchedule,
      networkPreferences: settings.networkPreferences ?? {},
      downloadsAtOnce: settings.downloadsAtOnce ?? 2,
      slowMode: settings.slowMode ?? false,
      slowModeSpeed: settings.slowModeSpeed ?? 2 * 1024 * 1024,
      speedUnit: settings.speedUnit ?? 'MB/s',
      destinationDir: settings.destinationDir ?? downloadsDir,
      customTags: settings.customTags ?? [],
      downloadTags: settings.downloadTags ?? {},
      destinationRules: settings.destinationRules ?? [],
      publisherPublicKeyPem: settings.publisherPublicKeyPem,
      publisherKeyFingerprint: settings.publisherKeyFingerprint,
      updateRepository: settings.updateRepository,
      autoUpdateEnabled: settings.autoUpdateEnabled ?? true
    } satisfies InitialState
  })
  // Window-control IPC is registered here because this is the active Electron bridge.
  // The older ipc/handlers.ts module is not used by main/index.ts.
  const getMainWindow = (): BrowserWindow | null => {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && !focused.isDestroyed()) return focused
    const first = BrowserWindow.getAllWindows()[0]
    return first && !first.isDestroyed() ? first : null
  }
  handle(C.minimizeWindow, () => {
    const window = getMainWindow()
    if (window) window.minimize()
  })
  handle(C.toggleMaximizeWindow, () => {
    const window = getMainWindow()
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  handle(C.closeWindow, () => {
    const window = getMainWindow()
    if (window) window.close()
  })
  handle(C.listInterfaces, async () => interfaces())
  handle(C.deviceBindingSupported, async () => true)
  handle(C.openNetworkSettings, async () => {
    await shell.openExternal('ms-settings:network')
  })
  const firefoxDefinition = {
    label: 'Firefox',
    url: 'about:addons',
    paths: [
      join(process.env.ProgramFiles ?? '', 'Mozilla Firefox', 'firefox.exe'),
      join(process.env['ProgramFiles(x86)'] ?? '', 'Mozilla Firefox', 'firefox.exe'),
      join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Firefox', 'firefox.exe')
    ]
  } as const
  const findFirefoxExecutable = (): string | undefined =>
    firefoxDefinition.paths.find((candidate) => candidate.length > 0 && existsSync(candidate))

  handle(C.openBrowserExtensionPage, async (browserId: 'firefox' | string) => {
    if (browserId !== 'firefox') return { opened: false, error: 'Automatic browser launching is only supported for Firefox.' }
    const executable = findFirefoxExecutable()
    if (!executable) return { opened: false, error: 'Firefox was not found in its standard installation locations.' }
    try {
      const child = spawn(executable, [firefoxDefinition.url], { detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
      return await new Promise<{ opened: boolean; error?: string }>((resolve) => {
        const timeout = setTimeout(() => resolve({ opened: false, error: 'Firefox did not accept the Add-ons Manager launch in time.' }), 2500)
        child.once('spawn', () => { clearTimeout(timeout); resolve({ opened: true }) })
        child.once('error', (error) => { clearTimeout(timeout); resolve({ opened: false, error: error.message }) })
      })
    } catch (error) {
      return { opened: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle(C.copyBrowserExtensionFolderPath, async (browserId: 'firefox' | string) => {
    if (browserId !== 'firefox') return { copied: false, error: 'Only the Firefox extension download is supported here.' }
    const candidates = [
      join(app.getAppPath(), 'extension', 'dist', 'SDMFFE.xpi'),
      join(process.cwd(), 'extension', 'dist', 'SDMFFE.xpi'),
      join(app.getAppPath(), '..', '..', 'assets', 'SDMFFE.xpi'),
      join(process.resourcesPath, 'browser-extensions', 'SDMFFE.xpi'),
      join(process.resourcesPath, 'assets', 'SDMFFE.xpi'),
      join(process.resourcesPath, 'SDMFFE.xpi')
    ]
    const source = candidates.find((candidate) => existsSync(candidate))
    if (!source) return { copied: false, error: 'The Firefox extension package SDMFFE.xpi was not found. Reinstall Sonic.' }
    const destination = join(downloadsDir, 'SDMFFE.xpi')
    try {
      await copyFile(source, destination)
      return { copied: true, path: destination }
    } catch (error) {
      return { copied: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle(C.copyChromiumExtensionFolderPath, async () => {
    const candidates = [
      join(process.resourcesPath, 'browser-extensions', 'chromium'),
      join(app.getAppPath(), 'extension', 'dist', 'chromium'),
      join(process.cwd(), 'extension', 'dist', 'chromium'),
      join(app.getAppPath(), 'resources', 'browser-extensions', 'chromium')
    ]
    const folder = candidates.find((candidate) => existsSync(join(candidate, 'manifest.json')))
    if (!folder) {
      return { copied: false, error: 'The packaged Chromium extension folder was not found. Rebuild or reinstall Sonic.' }
    }
    clipboard.writeText(folder)
    return { copied: true, path: folder }
  })

  const settingsSnapshot = (): AppSettings => ({
    ...settings,
    themeSource: settings.themeSource ?? 'sonic',
    downloadsAtOnce: settings.downloadsAtOnce ?? DOWNLOADS_AT_ONCE.default,
    slowMode: settings.slowMode ?? false,
    slowModeSpeed: settings.slowModeSpeed ?? DEFAULT_SLOW_MODE_SPEED,
    speedUnit: settings.speedUnit ?? 'MB/s',
    networkPreferences: settings.networkPreferences ?? {},
    destinationDir: settings.destinationDir ?? downloadsDir,
    customTags: settings.customTags ?? [],
    downloadTags: settings.downloadTags ?? {},
    destinationRules: settings.destinationRules ?? []
  })

  const publishSettings = async (patch: Record<string, unknown>): Promise<AppSettings> => {
    await saveSettings(patch)
    const persisted = await loadSettings()
    await torrentManager.applySettings(persisted)
    // Replace rather than merge: cleared optional preferences must stop affecting live policy.
    for (const key of Object.keys(settings) as (keyof AppSettings)[]) delete settings[key]
    Object.assign(settings, DEFAULT_SETTINGS, persisted)
    nativeTheme.themeSource = settings.themeSource === 'light' ? 'light' : 'dark'
    setBrandTheme()
    lastPolicySignature = null
    const snapshot = settingsSnapshot()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(C.settingsChanged, snapshot)
    }
    void emitSnapshot()
    return snapshot
  }

  handle(C.updateSettings, async (patch: AppSettings) => {
    await publishSettings(patch as unknown as Record<string, unknown>)
  })
  handle(C.listPlugins, async () => pluginRegistry.list())
  handle(C.reviewPluginManifest, async (manifestJson: string) =>
    pluginRegistry.review(manifestJson)
  )
  handle(C.trustPluginKey, async (keyId: string, publicKeyPem: string) => {
    await pluginRegistry.trustKey(keyId, publicKeyPem)
  })
  handle(C.revokePluginKey, async (keyId: string) => {
    await pluginRegistry.revokeKey(keyId)
  })
  handle(C.installPlugin, async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Select a Sonic plugin package',
      defaultPath: downloadsDir,
      properties: ['openFile'],
      filters: [{ name: 'Sonic plugin packages', extensions: ['sdm', 'json'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    const packageText = await readFile(picked.filePaths[0], 'utf8')
    return pluginRegistry.install(packageText)
  })
  handle(
    C.setPluginPermissions,
    async (pluginId: string, permissions: import('../shared/pluginApi').SonicPluginPermission[]) =>
      pluginRegistry.setPermissions(pluginId, permissions)
  )
  handle(C.setPluginEnabled, async (pluginId: string, enabled: boolean) =>
    pluginRegistry.setEnabled(pluginId, enabled)
  )
  handle(C.uninstallPlugin, async (pluginId: string) => pluginRegistry.uninstall(pluginId))
  handle(C.rollbackPlugin, async (pluginId: string) => pluginRegistry.rollback(pluginId))
  handle(C.probeUrl, async (url: string): Promise<ProbeResult> => {
    // Plugins are signed declarative rules only; they may resolve a known host or suggest a safe
    // filename. The main process still owns the network probe and its normal URL validation.
    const resolved = await pluginRegistry.resolveUrl(url)
    const result = await probeUrl(resolved ?? url)
    const suggestedFileName = await pluginRegistry.nameFile(url, result.suggestedFileName)
    return {
      ...result,
      requestedUrl: url,
      suggestedFileName: suggestedFileName ?? result.suggestedFileName
    }
  })
  ipcMain.removeHandler(C.previewSiteMirror)
  ipcMain.handle(
    C.previewSiteMirror,
    async (event, request: SiteMirrorRequest, operationId: string): Promise<SiteMirrorPreview> => {
      const trustedWindow = BrowserWindow.getAllWindows().some(
        (window) => !window.isDestroyed() && window.webContents === event.sender
      )
      if (!trustedWindow || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
        throw new Error('Site-mirror requests are only accepted from Sonic’s main window.')
      }
      if (typeof operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(operationId)) {
        throw new Error('Invalid site-mirror operation ID.')
      }
      if (siteMirrorControllers.has(operationId)) {
        throw new Error('A site-mirror preview with this operation ID is already running.')
      }
      const controller = new AbortController()
      siteMirrorControllers.set(operationId, controller)
      try {
        return await previewSiteMirror(request, {
          signal: controller.signal,
          onProgress: (progress) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send(C.siteMirrorProgress, {
                operationId,
                ...progress
              } satisfies SiteMirrorProgressEvent)
            }
          }
        })
      } finally {
        siteMirrorControllers.delete(operationId)
      }
    }
  )
  ipcMain.removeHandler(C.cancelSiteMirror)
  ipcMain.handle(C.cancelSiteMirror, async (event, operationId: string): Promise<void> => {
    const trustedWindow = BrowserWindow.getAllWindows().some(
      (window) => !window.isDestroyed() && window.webContents === event.sender
    )
    if (!trustedWindow || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Site-mirror cancellation is only accepted from Sonic’s main window.')
    }
    if (typeof operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(operationId)) {
      throw new Error('Invalid site-mirror operation ID.')
    }
    siteMirrorControllers.get(operationId)?.abort()
  })
  handle(C.chooseDestinationFolder, async (defaultPath: string) => {
    const result = await dialog.showOpenDialog({
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handle(C.chooseTorrentFile, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Torrent files', extensions: ['torrent'] }]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handle(C.readClipboardText, async () => clipboard.readText())
  handle(C.startDownload, async (request: StartDownloadRequest, linkId?: string) => {
    // Route only downloads using the configured default destination. An explicit folder chosen
    // for this download always wins over automation. Rules are ordered; the first enabled match wins.
    const configuredDefault = settings.destinationDir ?? downloadsDir
    if (request.destinationDir === configuredDefault) {
      const host = (() => {
        try {
          return new URL(request.url).hostname.toLowerCase()
        } catch {
          return ''
        }
      })()
      const filename = request.suggestedFileName.toLowerCase().split(/[?#]/, 1)[0]
      const rule = (settings.destinationRules ?? []).find((candidate) => {
        if (!candidate.enabled) return false
        const pattern = candidate.pattern.toLowerCase().trim()
        if (candidate.match === 'extension') {
          const extension = pattern.startsWith('.') ? pattern : `.${pattern}`
          return filename.endsWith(extension)
        }
        return Boolean(host) && (host === pattern || host.endsWith(`.${pattern}`))
      })
      if (rule) request = { ...request, destinationDir: rule.destinationDir }
    }
    const offer = linkId ? pendingLink(linkId) : undefined
    if (linkId && !offer)
      throw new Error('That browser-captured link has expired or was already dismissed.')
    if (request.kind === 'torrent') {
      const id = await torrentManager.start(request)
      if (linkId) releaseLink(linkId)
      void emitSnapshot()
      return id
    }
    if (request.mediaStream) {
      const currentSettings = settingsSnapshot()
      const [legacyItems, nativeItems] = await Promise.all([
        queue(),
        torrentManager.listDownloads()
      ])
      const mediaDownloads = mediaManager.listDownloads()
      const activeCount = [
        ...activeItems(legacyItems).map(mapItem),
        ...nativeItems,
        ...mediaDownloads
      ].filter((item) => item.state.status === 'downloading').length
      const queuedElsewhere =
        legacyItems.some((item) => item.status.toLowerCase() === 'queued') ||
        nativeItems.some((item) => item.state.status === 'queued')
      const alreadyQueuedMedia = mediaDownloads.some((item) => item.state.status === 'queued')
      const scheduleClosed = Boolean(
        currentSettings.downloadSchedule?.enabled &&
        !scheduleWindow(currentSettings.downloadSchedule).allowed
      )
      const policyBlock = mediaPolicyBlock(currentSettings)
      const slotFull = activeCount >= (currentSettings.downloadsAtOnce ?? DOWNLOADS_AT_ONCE.default)
      const queueReason = scheduleClosed
        ? 'Waiting for the scheduled download window to open.'
        : (policyBlock ??
          (queuedElsewhere
            ? 'Waiting for queued native/legacy downloads to start before media tasks.'
            : alreadyQueuedMedia
              ? 'Waiting for earlier media tasks.'
              : slotFull
                ? 'Waiting for a free download slot.'
                : undefined))
      const id = await mediaManager.start(request, Boolean(queueReason), queueReason)
      if (linkId) releaseLink(linkId)
      void pumpMediaQueue()
      void emitSnapshot()
      return id
    }
    const available = await torrentNetworks.refresh()
    const userEnabled = available.filter(
      (item) => settings.networkPreferences?.[item.id]?.off !== true
    )
    const requestedIds = Array.isArray(request.interfaceIds) ? request.interfaceIds : []
    const selectedIds = (
      requestedIds.length > 0 ? requestedIds : userEnabled.map((item) => item.id)
    ).filter((id) => settings.networkPreferences?.[id]?.off !== true)
    // Use the same durable engine that powers torrents and CLI-added HTTP downloads.
    // This keeps progress, retry, pause/resume, history, limits, and recovery consistent.
    const nativeRequest: StartDownloadRequest = {
      ...request,
      interfaceIds: selectedIds,
      ...(offer?.browser && !request.browser ? { browser: offer.browser } : {})
    }
    const id = await torrentManager.start(nativeRequest)
    if (linkId) releaseLink(linkId)
    void emitSnapshot()
    return id
  })
  handle(C.listRecoveryIssues, async () => [
    ...(await torrentManager.recoveryIssues()),
    ...mediaManager.recoveryIssues()
  ])
  handle(C.listDownloads, async () => {
    const [sonicItems, nativeItems] = await Promise.all([queue(), torrentManager.listDownloads()])
    const nativeIds = new Set(nativeItems.map((entry) => entry.state.id))
    return [
      ...activeItems(sonicItems).map(mapItem),
      ...nativeItems.filter((entry) => nativeIds.has(entry.state.id)),
      ...mediaManager.listDownloads()
    ]
  })
  handle(C.listHistory, async () => {
    const [sonicItems, nativeItems] = await Promise.all([queue(), nativeHistory()])
    return [...finishedItems(sonicItems).map(mapFinished), ...nativeItems].sort(
      (a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt)
    )
  })
  handle(C.clearHistory, async () => {
    await Promise.all([control({ command: 'clear' }), clearNativeHistory()])
    BrowserWindow.getAllWindows()[0]?.webContents.send(C.historyChanged)
  })
  handle(C.networkUsage, async (): Promise<Record<string, number>> => {
    // The native download engine owns the per-network usage ledger. The legacy queue backend
    // does not implement network-usage commands, so asking it here caused a rejected IPC call
    // on every renderer refresh. Wait for the ledger to load before returning its snapshot.
    await torrentManager.limits.loaded
    const used = torrentManager.limits.usedByPeriod()
    return Object.fromEntries(
      interfaces().map((network) => [network.id, Math.max(0, Number(used[network.id] ?? 0))])
    )
  })
  handle(C.resetNetworkUsage, async (id: string) => {
    if (!interfaces().some((item) => item.id === id))
      throw new Error('The selected network interface is no longer available.')
    await torrentManager.resetNetworkUsage(id)
  })
  handle(C.freeSpace, async (dir: string) => {
    try {
      const stats = await statfs(dir)
      return stats.bavail * stats.bsize
    } catch {
      return null
    }
  })
  handle(C.openDownload, async (id: string): Promise<boolean> => {
    if (mediaManager.has(id)) return mediaManager.open(id)
    if (await isNativeManaged(id)) return torrentManager.open(id)
    const item = (await queue()).find((entry) => entry.id === id)
    if (!item || !existsSync(item.destination)) return false
    const error = await shell.openPath(item.destination)
    return error.length === 0
  })
  handle(C.revealDownload, async (id: string): Promise<boolean> => {
    if (mediaManager.has(id)) return mediaManager.reveal(id)
    if (await isNativeManaged(id)) return torrentManager.reveal(id)
    const item = (await queue()).find((entry) => entry.id === id)
    if (!item || !existsSync(item.destination)) return false
    shell.showItemInFolder(item.destination)
    return true
  })
  const updatePublisherPublicKeyPem =
    UPDATE_PUBLISHER_PUBLIC_KEY_PEM || settings.publisherPublicKeyPem
  const updatePublisherKeyFingerprint =
    UPDATE_PUBLISHER_KEY_FINGERPRINT || settings.publisherKeyFingerprint
  handle(C.checkForUpdate, async (repository: string) =>
    checkForUpdate(repository, updatePublisherPublicKeyPem, updatePublisherKeyFingerprint)
  )
  handle(C.downloadVerifiedUpdate, async (repository: string) => {
    if (!updatePublisherPublicKeyPem || !updatePublisherKeyFingerprint)
      throw new Error('This development build has no pinned update publisher key. Signed release builds embed the trusted key automatically.')
    return downloadVerifiedUpdate(
      repository,
      updatePublisherPublicKeyPem,
      updatePublisherKeyFingerprint,
      (progress) => {
        const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
        if (window) window.webContents.send(C.updateDownloadProgress, progress)
      }
    )
  })
  handle(C.openVerifiedUpdate, async (operationId: string) => openVerifiedUpdate(operationId))
  handle(C.fingerprintPublisherKey, async (publicKeyPem: string) => {
    if (typeof publicKeyPem !== 'string' || publicKeyPem.length > 8192)
      throw new Error('Provide an Ed25519 public key PEM (maximum 8 KiB).')
    return fingerprintEd25519PublicKey(publicKeyPem)
  })
  handle(
    C.verifyPublisherManifest,
    async (manifestJson: string, publicKeyPem: string, expectedFingerprint: string) => {
      if (typeof manifestJson !== 'string' || manifestJson.length > 1024 * 1024)
        throw new Error('Signed manifest must be valid JSON under 1 MiB.')
      const actualFingerprint = fingerprintEd25519PublicKey(publicKeyPem)
      const expected = expectedFingerprint.trim().toLowerCase()
      if (!/^[a-f0-9]{64}$/.test(expected) || actualFingerprint !== expected)
        throw new Error(
          'Publisher key fingerprint does not match the independently pinned fingerprint.'
        )
      let parsed: unknown
      try {
        parsed = JSON.parse(manifestJson)
      } catch {
        throw new Error('Manifest is not valid JSON.')
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Manifest must be a JSON object.')
      const result = verifySignedManifest(
        parsed as { payload: string; signature: string; keyId?: string },
        publicKeyPem
      )
      if (!result.valid)
        throw new Error('Publisher signature is invalid; do not trust this manifest.')
      return result
    }
  )
  handle(C.verifyFileSha256, async (expectedHash: string) => {
    const picked = await dialog.showOpenDialog({
      title: 'Select a file to verify',
      properties: ['openFile']
    })
    if (picked.canceled || !picked.filePaths[0]) return { cancelled: true as const }
    const filePath = picked.filePaths[0]
    const result = await verifyFileSha256(filePath, expectedHash)
    return { cancelled: false as const, fileName: basename(filePath), ...result }
  })
  handle(C.torrentFiles, async (id: string) => torrentManager.torrentFiles(id))
  handle(C.chooseTorrentFiles, async (id: string, selected: number[]) =>
    torrentManager.chooseTorrentFiles(id, selected)
  )
  handle(C.setTorrentFilePriority, async (id: string, fileIndex: number, priority: 0 | 1 | 2) => {
    await torrentManager.setTorrentFilePriority(id, fileIndex, priority)
    void emitSnapshot()
  })
  handle(C.setTorrentTrackers, async (id: string, trackers: string[]) => {
    await torrentManager.setTorrentTrackers(id, trackers)
    void emitSnapshot()
  })
  handle(C.previewTorrentFile, async (id: string, fileIndex: number) =>
    torrentManager.previewTorrentFile(id, fileIndex)
  )
  handle(C.previewHttpMedia, async (id: string) => torrentManager.previewHttpMedia(id))
  handle(C.canPreviewHttpMedia, async (id: string) => torrentManager.canPreviewHttpMedia(id))
  handle(C.chooseFfmpegExecutable, async (): Promise<{ path: string; sha256: string } | null> => {
    const picked = await dialog.showOpenDialog({
      title: 'Choose a trusted FFmpeg executable',
      properties: ['openFile'],
      ...(process.platform === 'win32'
        ? { filters: [{ name: 'FFmpeg executable', extensions: ['exe'] }] }
        : {})
    })
    const path = picked.filePaths[0]
    if (picked.canceled || !path) return null
    return { path, sha256: await sha256File(path) }
  })
  handle(
    C.startMediaConversion,
    async (id: string, options: import('../shared/types').MediaConversionOptions) =>
      mediaConversionManager.start(id, options)
  )
  handle(C.cancelMediaConversion, async (operationId: string) =>
    mediaConversionManager.cancel(operationId)
  )
  handle(C.pauseDownload, async (id: string) => {
    if (mediaManager.has(id)) await mediaManager.pause(id)
    else if (await isNativeManaged(id)) await torrentManager.pause(id)
    else await control({ command: 'pause', id })
    void emitSnapshot()
  })
  handle(C.resumeDownload, async (id: string) => {
    if (mediaManager.has(id)) await mediaManager.resume(id)
    else if (await isNativeManaged(id)) torrentManager.resume(id)
    else await control({ command: 'resume', id })
    void emitSnapshot()
  })
  handle(C.relinkDownload, async (id: string, url: string) => {
    if (await isNativeManaged(id)) await torrentManager.relink(id, url)
    else await control({ command: 'relink', id, url })
    void emitSnapshot()
  })
  handle(C.setDownloadNetwork, async (id: string, networkId: string, enabled: boolean) => {
    if (await isNativeManaged(id)) {
      await torrentManager.setNetworkEnabled(id, networkId, enabled)
      void emitSnapshot()
      return
    }
    const all = interfaces()
    const target = all.find((item) => item.id === networkId)
    if (!target) throw new Error('The selected network interface is no longer available.')
    const existingItem = (await queue()).find((item) => item.id === id)
    if (!existingItem) throw new Error('Download not found.')
    const targetAddresses = target.addresses
      .filter((address) => address.family === 4)
      .map((address) => address.address)
    if (targetAddresses.length === 0)
      throw new Error('The selected interface has no usable IPv4 address.')
    const selected = new Set(existingItem.sourceAddresses ?? [])
    if (enabled) {
      for (const address of targetAddresses) selected.add(address)
    } else {
      if (selected.size === 0) {
        for (const network of all) {
          if (network.id === networkId) continue
          for (const address of network.addresses.filter((value) => value.family === 4))
            selected.add(address.address)
        }
      } else {
        for (const address of targetAddresses) selected.delete(address)
      }
    }
    await control({ command: 'set-networks', id, sourceAddresses: [...selected] })
    void emitSnapshot()
  })
  handle(C.setDownloadSpeedLimit, async (id: string, bytesPerSecond: number | null) => {
    if (mediaManager.has(id)) await mediaManager.setDownloadSpeedLimit(id, bytesPerSecond)
    else {
      if (!(await isNativeManaged(id))) {
        throw new Error('Per-download speed limits are only available for Sonic-managed downloads.')
      }
      await torrentManager.setDownloadSpeedLimit(id, bytesPerSecond)
    }
    void emitSnapshot()
  })
  handle(C.setDownloadPriority, async (id: string, priority: 0 | 1 | 2) => {
    if (!(await isNativeManaged(id))) {
      throw new Error('Queue priority is only available for Sonic-managed downloads.')
    }
    await torrentManager.setDownloadPriority(id, priority)
    void emitSnapshot()
  })
  handle(C.setUploadSpeedLimit, async (id: string, bytesPerSecond: number | null) => {
    if (!(await isNativeManaged(id))) {
      throw new Error('Per-download upload limits are only available for Sonic-managed torrents.')
    }
    await torrentManager.setUploadSpeedLimit(id, bytesPerSecond)
    void emitSnapshot()
  })
  handle(C.setUploadRatioLimit, async (id: string, ratio: number | null) => {
    if (!(await isNativeManaged(id))) {
      throw new Error('Upload ratio limits are only available for Sonic-managed torrents.')
    }
    await torrentManager.setUploadRatioLimit(id, ratio)
    void emitSnapshot()
  })
  handle(C.refreshTorrentTrackers, async (id: string) => {
    if (!(await isNativeManaged(id))) {
      throw new Error('Tracker refresh is only available for Sonic-managed torrents.')
    }
    await torrentManager.refreshTorrentTrackers(id)
    void emitSnapshot()
  })
  handle(C.stopSeeding, async (id: string) => {
    if (!(await isNativeManaged(id))) {
      throw new Error('Stopping seeding is only available for Sonic-managed torrents.')
    }
    await torrentManager.stopSeeding(id)
    BrowserWindow.getAllWindows()[0]?.webContents.send(C.historyChanged)
    void emitSnapshot()
  })
  handle(C.cancelDownload, async (id: string) => {
    if (mediaManager.has(id)) await mediaManager.cancel(id)
    else if (await isNativeManaged(id)) await torrentManager.cancel(id)
    else await control({ command: 'cancel', id })
    void emitSnapshot()
  })
  handle(C.removeDownload, async (id: string, options?: { trashFile?: boolean }) => {
    if (mediaManager.has(id)) {
      await mediaManager.remove(id, options?.trashFile === true)
      void emitSnapshot()
      return
    }
    if (await isNativeManaged(id)) {
      await torrentManager.remove(id, options?.trashFile === true)
      BrowserWindow.getAllWindows()[0]?.webContents.send(C.historyChanged)
      void emitSnapshot()
      return
    }
    const item = (await queue()).find((entry) => entry.id === id)
    if (!item) throw new Error('Download not found.')
    if (['Queued', 'Running', 'Paused'].includes(item.status)) {
      await control({ command: 'cancel', id })
      let terminal: QueueItem | undefined
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        terminal = (await queue()).find((entry) => entry.id === id)
        if (terminal && !['Queued', 'Running', 'Paused'].includes(terminal.status)) break
      }
      if (!terminal || ['Queued', 'Running', 'Paused'].includes(terminal.status))
        throw new Error(
          'Download cancellation is still in progress; try removing it again shortly.'
        )
    }
    const current = (await queue()).find((entry) => entry.id === id)
    if (
      current &&
      options?.trashFile &&
      existsSync(current.destination) &&
      current.status === 'Completed'
    )
      await shell.trashItem(current.destination)
    if (current) {
      await control({ command: 'remove', id })
      // The legacy queue removes completed results from its own list. Copy the completed record
      // into Sonic's durable history first, then mark it hidden from the main list.
      if (current.status === 'Completed') {
        await addNativeHistory(mapFinished(current))
        await markNativeHistoryRemoved(id)
      }
    }
    BrowserWindow.getAllWindows()[0]?.webContents.send(C.historyChanged)
    void emitSnapshot()
  })
  handle(C.pendingLinks, async () => pendingLinks())
  handle(C.resumeFromLink, async (linkId: string, downloadId: string) => {
    const offer = pendingLink(linkId)
    if (!offer || !offer.probe || offer.probe.kind !== 'http')
      throw new Error('That captured link is no longer available as a direct HTTP(S) download.')
    if (offer.resumes && offer.resumes.id !== downloadId)
      throw new Error('That browser link was matched to a different failed download.')
    await control({
      command: 'relink',
      id: downloadId,
      url: offer.probe.finalUrl,
      browser: offer.browser
    })
    releaseLink(linkId)
    void emitSnapshot()
  })
  handle(C.dismissLink, async (id: string) => {
    releaseLink(id)
  })
  handle(C.saveDiagnosticReport, async (content: string): Promise<boolean> => {
    if (typeof content !== 'string' || content.length > 1_000_000)
      throw new Error('Diagnostic report is invalid or too large.')
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new Error('Diagnostic report must be valid JSON.')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Diagnostic report must be a JSON object.')
    const saved = await dialog.showSaveDialog({
      title: 'Export Sonic diagnostic report',
      defaultPath: `Sonic-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON diagnostic report', extensions: ['json'] }]
    })
    if (saved.canceled || !saved.filePath) return false

    // Collect recent main-process diagnostics at the trusted boundary. Logs have already been
    // redacted and bounded in memory; the combined report is redacted again before disk write.
    const enriched = {
      ...(parsed as Record<string, unknown>),
      capture: {
        collectedAt: new Date().toISOString(),
        applicationVersion: app.getVersion(),
        electronVersion: process.versions.electron ?? 'unknown',
        nodeVersion: process.versions.node ?? 'unknown'
      },
      runtimeLogs: getRuntimeLogSnapshot()
    }
    await writeFile(
      saved.filePath,
      JSON.stringify(redactDiagnosticReport(enriched), null, 2) + String.fromCharCode(10),
      'utf8'
    )
    return true
  })
  handle(C.exportStorageBackup, async (kind: 'settings' | 'history' = 'settings'): Promise<boolean> => {
    const isHistory = kind === 'history'
    const content = isHistory ? await createHistoryBackup() : await createSettingsBackup()
    const date = new Date().toISOString().slice(0, 10)
    const saved = await dialog.showSaveDialog({
      title: isHistory ? 'Export Sonic download history' : 'Export Sonic settings',
      defaultPath: isHistory
        ? `Sonic-history-${date}.sonic-history.json`
        : `Sonic-settings-${date}.sonic-settings.json`,
      filters: [{ name: isHistory ? 'Sonic history backup' : 'Sonic settings backup', extensions: ['json'] }]
    })
    if (saved.canceled || !saved.filePath) return false
    await writeFile(saved.filePath, content, { encoding: 'utf8', mode: 0o600 })
    return true
  })
  handle(C.restoreStorageBackup, async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Restore Sonic backup or download history',
      properties: ['openFile'],
      filters: [{ name: 'Sonic backup or history JSON', extensions: ['json'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    const content = await readFile(picked.filePaths[0], 'utf8')
    if (isHistoryBackup(content)) {
      const confirm = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Import history', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Restore download history?',
        message: 'Sonic will merge the saved download history with your current history.',
        detail: 'A safety copy of your current history will be preserved before importing.'
      })
      if (confirm.response !== 0) return null
      const result = await restoreHistoryBackup(content)
      BrowserWindow.getAllWindows()[0]?.webContents.send(C.historyChanged)
      return { kind: 'history' as const, ...result }
    }
    if (isSettingsBackup(content)) {
      const confirm = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Restore settings and restart', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Restore Sonic settings?',
        message: 'Sonic will replace the current application settings with the settings in this file.',
        detail: 'A safety copy of the current settings will be preserved before restoring.'
      })
      if (confirm.response !== 0) return null
      const result = await restoreSettingsBackup(content)
      app.relaunch()
      app.exit(0)
      return { kind: 'settings' as const, ...result }
    }
    const active = [
      ...(await queue())
        .filter((item) => ['Running', 'Downloading'].includes(item.status))
        .map((item) => item.id),
      ...(await torrentManager.listDownloads())
        .filter((item) => item.state.status === 'downloading')
        .map((item) => item.state.id),
      ...(await mediaManager.listDownloads())
        .filter((item) => item.state.status === 'downloading')
        .map((item) => item.state.id)
    ]
    if (active.length) throw new Error('Pause active downloads before restoring a Sonic backup.')
    const confirm = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Restore and restart', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Restore Sonic backup?',
      message:
        'Sonic will preserve a safety copy of current settings/history, merge saved history and restore missing queue manifests. Existing task IDs will not be overwritten.',
      detail:
        'Downloaded file contents are not included in the backup. Restored tasks need their original partial/output files to resume. Sonic will restart to load restored tasks.'
    })
    if (confirm.response !== 0) return null
    const result = await restoreStorageBackup(content)
    app.relaunch()
    app.exit(0)
    return { kind: 'sonic' as const, ...result }
  })
  handle(C.getStorageInfo, async () => ({
    userDataDir: app.getPath('userData')
  }))
  const dispatchControl = async (request: Record<string, unknown>): Promise<unknown> => {
    const textOf = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = request[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
        if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      }
      return undefined
    }
    const parseOnOff = (value: unknown): boolean | undefined => {
      if (value === true || value === 1) return true
      if (value === false || value === 0) return false
      if (typeof value !== 'string') return undefined
      const normalized = value.trim().toLowerCase()
      if (['on', 'true', 'yes', '1', 'enabled'].includes(normalized)) return true
      if (['off', 'false', 'no', '0', 'disabled'].includes(normalized)) return false
      return undefined
    }
    const parseList = (value: unknown): string[] | undefined => {
      if (Array.isArray(value))
        return value
          .map(String)
          .map((item) => item.trim())
          .filter(Boolean)
      if (typeof value !== 'string' || !value.trim()) return undefined
      return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    }
    const parseIndexes = (value: unknown): number[] | undefined => {
      const raw = parseList(value)
      if (!raw) return undefined
      const indexes = raw.map(Number)
      if (!indexes.every((index) => Number.isInteger(index) && index >= 0)) {
        throw new Error('File indexes must be comma-separated non-negative integers.')
      }
      return indexes
    }
    const rateToBytes = (value: unknown, unitValue: unknown): number | undefined => {
      if (value === undefined || value === null) return undefined
      const raw = String(value).trim().toLowerCase()
      if (['off', 'none', 'unlimited', 'null', ''].includes(raw)) return undefined
      const amount = Number(raw)
      if (!Number.isFinite(amount) || amount < 0)
        throw new Error('Speed must be a non-negative number or off.')
      if (amount === 0) return undefined
      const unit = String(unitValue ?? 'MiB/s')
        .trim()
        .toLowerCase()
        .replace(/\s/g, '')
      const factors: Record<string, number> = {
        'b/s': 1,
        'byte/s': 1,
        'bytes/s': 1,
        'kb/s': 1000,
        'kib/s': 1024,
        'mb/s': 1000 ** 2,
        'mib/s': 1024 ** 2,
        'gb/s': 1000 ** 3,
        'gib/s': 1024 ** 3,
        kbps: 1000 / 8,
        'kbit/s': 1000 / 8,
        mbps: 1000 ** 2 / 8,
        'mbit/s': 1000 ** 2 / 8,
        gbps: 1000 ** 3 / 8,
        'gbit/s': 1000 ** 3 / 8
      }
      const factor = factors[unit]
      if (factor === undefined) throw new Error('Unknown speed unit: ' + String(unitValue))
      const bytes = Math.round(amount * factor)
      if (!Number.isSafeInteger(bytes) || bytes <= 0)
        throw new Error('Speed is outside the supported range.')
      return bytes
    }
    const effectiveSettings = (): AppSettings => settingsSnapshot()
    const externalQueue = async (): Promise<QueueItem[]> => {
      try {
        return await queue()
      } catch {
        return []
      }
    }
    const nativeUpdates = async (): Promise<DownloadUpdate[]> => torrentManager.listDownloads()
    const allUpdates = async (): Promise<DownloadUpdate[]> => {
      const [legacy, native] = await Promise.all([externalQueue(), nativeUpdates()])
      const nativeIds = new Set(native.map((entry) => entry.state.id))
      const legacyUpdates = activeItems(legacy)
        .filter((entry) => !nativeIds.has(entry.id))
        .map(mapItem)
      return [...legacyUpdates, ...native].sort((a, b) => a.state.startedAt - b.state.startedAt)
    }
    const allHistory = async (): Promise<FinishedDownload[]> => {
      const [legacy, native] = await Promise.all([externalQueue(), nativeHistory()])
      const nativeIds = new Set(native.map((entry) => entry.id))
      const legacyHistory = finishedItems(legacy)
        .filter((entry) => !nativeIds.has(entry.id))
        .map(mapFinished)
      return [...legacyHistory, ...native].sort(
        (a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt)
      )
    }
    const summarize = (
      state: DownloadUpdate['state'] | FinishedDownload
    ): Record<string, unknown> => ({
      id: state.id,
      kind: state.kind,
      name: state.fileName,
      status: state.status,
      url: state.url,
      destination: state.destinationPath,
      downloadedBytes: state.bytesDownloaded,
      totalBytes: state.totalBytes,
      progressPercent:
        state.totalBytes > 0
          ? Math.round((state.bytesDownloaded / state.totalBytes) * 10000) / 100
          : null,
      speedBytesPerSec: state.speedBytesPerSec,
      speedUnit: effectiveSettings().speedUnit ?? 'MB/s',
      error: state.error,
      startedAt: new Date(state.startedAt).toISOString(),
      completedAt: state.completedAt ? new Date(state.completedAt).toISOString() : null,
      ...(state.kind === 'torrent'
        ? { peers: 'peers' in state ? state.peers.length : null, files: state.files }
        : {}),
      ...('missing' in state ? { missing: state.missing, unitsWritten: state.unitsWritten } : {})
    })
    const sendHistoryChanged = (): void => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(C.historyChanged)
      }
    }
    const updateSettings = async (patch: Record<string, unknown>): Promise<AppSettings> =>
      publishSettings(patch)
    const applySettingByKey = async (keyValue: string, value: unknown): Promise<AppSettings> => {
      const keyMap: Record<string, string> = {
        theme: 'themeSource',
        mode: 'themeSource',
        'speed-unit': 'speedUnit',
        'slow-mode': 'slowMode',
        'slow-mode-speed': 'slowModeSpeed',
        'speed-limit': 'speedLimit',
        'downloads-at-once': 'downloadsAtOnce',
        'destination-dir': 'destinationDir',
        'download-schedule': 'downloadSchedule',
        'network-preferences': 'networkPreferences',
        'browser-extension-used': 'browserExtensionUsed'
      }
      const key = keyMap[keyValue] ?? keyValue
      let normalized: unknown = value
      if (key === 'themeSource') {
        normalized = String(value).toLowerCase()
        if (!['sonic', 'light', 'dark'].includes(normalized as string))
          throw new Error('Theme must be sonic, light, or dark.')
      } else if (key === 'speedUnit') {
        const unit = String(value).toLowerCase()
        normalized = ['bits', 'mbps', 'mbit/s', 'mbit'].includes(unit)
          ? 'bits'
          : ['bytes', 'mb/s', 'mib/s', 'mb', 'mib'].includes(unit)
            ? 'bytes'
            : undefined
        if (!normalized) throw new Error('Speed unit must be bytes (MB/s) or bits (Mbps).')
      } else if (key === 'slowMode') {
        const parsed = parseOnOff(value)
        if (parsed === undefined) throw new Error('slowMode must be on or off.')
        normalized = parsed
      } else if (key === 'speedLimit' || key === 'slowModeSpeed') {
        normalized = rateToBytes(value, request.unit)
        if (key === 'slowModeSpeed' && normalized === undefined)
          throw new Error('Slow-mode speed must be a positive rate.')
      } else if (key === 'downloadsAtOnce') {
        const count = Number(value)
        if (
          !Number.isInteger(count) ||
          count < DOWNLOADS_AT_ONCE.min ||
          count > DOWNLOADS_AT_ONCE.max
        ) {
          throw new Error(
            'Concurrent downloads must be between ' +
              DOWNLOADS_AT_ONCE.min +
              ' and ' +
              DOWNLOADS_AT_ONCE.max +
              '.'
          )
        }
        normalized = count
      } else if (key === 'destinationDir') {
        normalized = resolve(String(value))
      } else if (key === 'downloadSchedule' || key === 'networkPreferences') {
        if (typeof normalized === 'string') {
          try {
            normalized = JSON.parse(normalized)
          } catch {
            throw new Error(key + ' must be valid JSON.')
          }
        }
      } else if (key === 'browserExtensionUsed') {
        const parsed = parseOnOff(value)
        if (parsed === undefined) throw new Error('browserExtensionUsed must be on or off.')
        normalized = parsed
      }
      return updateSettings({ [key]: normalized })
    }
    const startDownloadFromCli = async (rawUrl: string): Promise<Record<string, unknown>> => {
      const probe = await probeUrl(rawUrl)
      const available = await torrentNetworks.refresh()
      const selectedRaw = parseList(request.interfaces ?? request.interfaceIds)
      const interfaceIds =
        selectedRaw ??
        available
          .filter((iface) => settings.networkPreferences?.[iface.id]?.off !== true)
          .map((iface) => iface.id)
      const destDirArg = textOf('destinationDir', 'destination-dir')
      const legacyDestination = textOf('destination')
      let destinationDir = resolve(destDirArg ?? settings.destinationDir ?? downloadsDir)
      let suggestedFileName = textOf('name', 'fileName', 'file-name')
      if (!destDirArg && legacyDestination) {
        const fullPath = resolve(legacyDestination)
        if (
          (existsSync(fullPath) && statSync(fullPath).isDirectory()) ||
          /[\\/]$/.test(legacyDestination)
        ) {
          destinationDir = fullPath
        } else {
          destinationDir = dirname(fullPath)
          suggestedFileName ??= basename(fullPath)
        }
      }
      suggestedFileName ??= probe.suggestedFileName || 'download'
      const chosenIndexes = parseIndexes(request.files ?? request.selectedFiles)
      let downloadRequest: StartDownloadRequest
      if (probe.kind === 'torrent') {
        downloadRequest = {
          kind: 'torrent',
          url: rawUrl,
          destinationDir,
          suggestedFileName,
          totalBytes:
            probe.totalBytes ?? probe.torrent.files.reduce((sum, file) => sum + file.length, 0),
          supportsRanges: false,
          interfaceIds,
          etag: null,
          lastModified: null,
          infoHash: probe.torrent.infoHash,
          ...(chosenIndexes ? { selectedFiles: chosenIndexes } : {})
        }
      } else {
        downloadRequest = {
          kind: 'http',
          url: probe.finalUrl,
          destinationDir,
          suggestedFileName,
          totalBytes: probe.totalBytes ?? 0,
          supportsRanges: probe.supportsRanges,
          interfaceIds,
          etag: probe.etag,
          lastModified: probe.lastModified
        }
      }
      // CLI requests without an explicit destination use the same ordered auto-routing rules as the UI.
      if (!destDirArg && !legacyDestination) {
        const host = (() => {
          try {
            return new URL(rawUrl).hostname.toLowerCase()
          } catch {
            return ''
          }
        })()
        const filename = suggestedFileName.toLowerCase().split(/[?#]/, 1)[0]
        const rule = (settings.destinationRules ?? []).find((candidate) => {
          if (!candidate.enabled) return false
          const pattern = candidate.pattern.toLowerCase().trim()
          if (candidate.match === 'extension')
            return filename.endsWith(pattern.startsWith('.') ? pattern : `.${pattern}`)
          return Boolean(host) && (host === pattern || host.endsWith(`.${pattern}`))
        })
        if (rule) {
          destinationDir = rule.destinationDir
          downloadRequest = { ...downloadRequest, destinationDir }
        }
      }
      const id = await torrentManager.start(downloadRequest)
      void emitSnapshot()
      const snapshot = (await nativeUpdates()).find((entry) => entry.state.id === id)
      return {
        id,
        name: snapshot?.state.fileName ?? suggestedFileName,
        kind: probe.kind,
        status: snapshot?.state.status ?? 'downloading',
        destinationDir,
        totalBytes: snapshot?.state.totalBytes ?? probe.totalBytes
      }
    }

    const command = (textOf('command') ?? '').toLowerCase()
    const id = textOf('id', 'downloadId', 'download-id')
    const argValue = request.value ?? request.mode ?? request.state ?? request.enabled
    switch (command) {
      case 'status':
      case 'app-status': {
        const [downloads, history] = await Promise.all([allUpdates(), allHistory()])
        const prefs = effectiveSettings()
        const recoveryIssues = torrentManager.listRecoveryIssues()
        return {
          application: 'Sonic',
          connected: true,
          version: app.getVersion(),
          mode: prefs.themeSource,
          slowMode: prefs.slowMode,
          speedUnit: prefs.speedUnit,
          speedLimitBytesPerSecond: prefs.slowMode
            ? (prefs.slowModeSpeed ?? DEFAULT_SLOW_MODE_SPEED)
            : null,
          slowModeSpeedBytesPerSecond: prefs.slowModeSpeed,
          effectiveSpeedLimitBytesPerSecond: prefs.slowMode
            ? (prefs.slowModeSpeed ?? DEFAULT_SLOW_MODE_SPEED)
            : null,
          downloadsAtOnce: prefs.downloadsAtOnce,
          activeDownloadCount: downloads.filter((entry) => entry.state.status === 'downloading')
            .length,
          pausedDownloadCount: downloads.filter((entry) => entry.state.status === 'paused').length,
          queuedDownloadCount: downloads.filter((entry) => entry.state.status === 'queued').length,
          finishedHistoryCount: history.length,
          recoveryIssueCount: recoveryIssues.length,
          recoveryIssues,
          downloads: downloads.map((entry) => summarize(entry.state))
        }
      }
      case 'recovery':
      case 'recovery-issues':
        return torrentManager.listRecoveryIssues()
      case 'settings':
      case 'settings-get':
      case 'config':
        return effectiveSettings()
      case 'settings-set': {
        if (request.patch && typeof request.patch === 'object' && !Array.isArray(request.patch)) {
          return updateSettings(request.patch as Record<string, unknown>)
        }
        const json = textOf('json', 'patchJson', 'patch-json')
        if (json) {
          let patch: unknown
          try {
            patch = JSON.parse(json)
          } catch {
            throw new Error('--json must contain a valid JSON object.')
          }
          if (!patch || typeof patch !== 'object' || Array.isArray(patch))
            throw new Error('--json must contain a JSON object.')
          return updateSettings(patch as Record<string, unknown>)
        }
        const key = textOf('key')
        if (!key || request.value === undefined)
          throw new Error(
            'Use settings-set --key <name> --value <value> or settings-set --json <object>.'
          )
        return applySettingByKey(key, request.value)
      }
      case 'theme':
      case 'mode': {
        const value = textOf('value', 'mode', 'theme')
        if (!value) return { mode: effectiveSettings().themeSource }
        return applySettingByKey('themeSource', value)
      }
      case 'slow-mode': {
        if (argValue === undefined || String(argValue).toLowerCase() === 'status') {
          return {
            slowMode: effectiveSettings().slowMode,
            slowModeSpeedBytesPerSecond: effectiveSettings().slowModeSpeed
          }
        }
        const value =
          String(argValue).toLowerCase() === 'toggle'
            ? !effectiveSettings().slowMode
            : parseOnOff(argValue)
        if (value === undefined) throw new Error('Use slow-mode on, off, toggle, or status.')
        return updateSettings({ slowMode: value })
      }
      case 'speed-unit': {
        const value = textOf('value', 'unit')
        if (!value)
          return {
            speedUnit: effectiveSettings().speedUnit ?? 'MB/s',
            display: effectiveSettings().speedUnit ?? 'MB/s'
          }
        return applySettingByKey('speedUnit', value)
      }
      case 'speed-limit': {
        if (argValue === undefined)
          return { slowModeSpeedBytesPerSecond: effectiveSettings().slowModeSpeed }
        const rate = rateToBytes(argValue, request.unit)
        if (rate === undefined) throw new Error('Slow-mode speed must be a positive rate.')
        return updateSettings({ slowModeSpeed: rate })
      }
      case 'slow-mode-speed': {
        if (argValue === undefined)
          return { slowModeSpeedBytesPerSecond: effectiveSettings().slowModeSpeed }
        const rate = rateToBytes(argValue, request.unit)
        if (rate === undefined) throw new Error('Slow-mode speed must be a positive rate.')
        return updateSettings({ slowModeSpeed: rate })
      }
      case 'downloads-at-once': {
        if (argValue === undefined) return { downloadsAtOnce: effectiveSettings().downloadsAtOnce }
        return applySettingByKey('downloadsAtOnce', argValue)
      }
      case 'destination':
      case 'destination-dir': {
        const value = textOf('value', 'path', 'destinationDir')
        if (!value) return { destinationDir: effectiveSettings().destinationDir }
        return applySettingByKey('destinationDir', value)
      }
      case 'list':
      case 'downloads':
      case 'download-list':
        return (await allUpdates()).map((entry) => summarize(entry.state))
      case 'history':
      case 'history-list':
        return (await allHistory()).map((entry) => summarize(entry))
      case 'history-clear':
      case 'clear-history':
      case 'history-clear-all':
        await Promise.all([control({ command: 'clear' }), clearNativeHistory()])
        sendHistoryChanged()
        return {
          cleared: true,
          message: 'Finished download history cleared; downloaded files were not deleted.'
        }
      case 'history-delete':
      case 'delete-history': {
        if (!id) throw new Error('Provide --id <download-id>.')
        const nativeEntry = (await nativeHistory()).some((entry) => entry.id === id)
        if (nativeEntry) {
          await clearNativeHistory([id])
          sendHistoryChanged()
          return { deleted: true, id }
        }
        const entry = (await externalQueue()).find((item) => item.id === id)
        if (!entry || activeItems([entry]).length)
          throw new Error('Finished history item not found: ' + id)
        await control({ command: 'remove', id })
        sendHistoryChanged()
        return { deleted: true, id }
      }
      case 'add':
      case 'download':
      case 'download-add': {
        const url = textOf('url', 'link', 'source')
        if (!url) throw new Error('Provide --url <HTTP(S)-URL|magnet-link|path-to-torrent-file>.')
        return startDownloadFromCli(url)
      }
      case 'analyze':
      case 'probe': {
        const url = textOf('url', 'link', 'source')
        if (!url) throw new Error('Provide --url <link-or-torrent-file>.')
        return probeUrl(url)
      }
      case 'start':
      case 'queue-start':
        return control({ command: 'start' })
      case 'pause':
      case 'resume':
      case 'cancel': {
        if (!id) throw new Error('Provide --id <download-id>.')
        const native = await nativeUpdates()
        const local = native.find((entry) => entry.state.id === id)
        if (local) {
          if (command === 'pause') {
            await torrentManager.pause(id)
          } else if (command === 'resume') {
            torrentManager.resume(id)
            // Resume verifies the partial file asynchronously. Wait briefly so the CLI reports
            // the state it actually reached, rather than the paused state it started from.
            for (let attempt = 0; attempt < 20; attempt++) {
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
              const latest = (await nativeUpdates()).find((entry) => entry.state.id === id)
              if (!latest || latest.state.status !== 'paused') break
            }
          } else {
            await torrentManager.cancel(id)
          }
          void emitSnapshot()
          return {
            id,
            action: command,
            status:
              (await nativeUpdates()).find((entry) => entry.state.id === id)?.state.status ??
              (command === 'cancel' ? 'cancelled' : command === 'pause' ? 'paused' : 'missing')
          }
        }
        const legacy = (await externalQueue()).find((entry) => entry.id === id)
        if (!legacy) throw new Error('Download not found: ' + id)
        if (command === 'pause' || command === 'resume' || command === 'cancel') {
          await control({ command, id })
          return { id, action: command, success: true }
        }
        throw new Error('Unsupported download action: ' + command)
      }
      case 'pause-all':
      case 'resume-all':
      case 'cancel-all': {
        const [native, legacy] = await Promise.all([nativeUpdates(), externalQueue()])
        const operation = command.slice(0, -4)
        const nativeWork = native
          .filter((entry) => {
            const status = entry.state.status
            if (operation === 'pause') return status === 'downloading' || status === 'queued'
            if (operation === 'resume') return status === 'paused' || status === 'error'
            return (
              status === 'downloading' ||
              status === 'paused' ||
              status === 'queued' ||
              status === 'error'
            )
          })
          .map(async (entry) => {
            if (operation === 'pause') await torrentManager.pause(entry.state.id)
            else if (operation === 'resume') torrentManager.resume(entry.state.id)
            else await torrentManager.cancel(entry.state.id)
            return entry.state.id
          })
        const legacyWork = activeItems(legacy).map((entry) =>
          control({ command: operation, id: entry.id }).then(() => entry.id)
        )
        const results = await Promise.allSettled([...nativeWork, ...legacyWork])
        void emitSnapshot()
        return {
          action: operation,
          affected: results.filter((entry) => entry.status === 'fulfilled').length,
          errors: results
            .filter((entry) => entry.status === 'rejected')
            .map((entry) => String((entry as PromiseRejectedResult).reason))
        }
      }
      case 'remove':
      case 'download-remove': {
        if (!id) throw new Error('Provide --id <download-id>.')
        const trashFile = parseOnOff(request.trashFile ?? request['trash-file']) === true
        const native = await nativeUpdates()
        if (
          native.some((entry) => entry.state.id === id) ||
          (await nativeHistory()).some((entry) => entry.id === id)
        ) {
          await torrentManager.remove(id, trashFile)
          void emitSnapshot()
          sendHistoryChanged()
          return { removed: true, id, trashFile }
        }
        let item = (await externalQueue()).find((entry) => entry.id === id)
        if (!item) throw new Error('Download not found: ' + id)
        if (activeItems([item]).length) {
          await control({ command: 'cancel', id })
          for (let attempt = 0; attempt < 40; attempt++) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
            item = (await externalQueue()).find((entry) => entry.id === id)
            if (item && activeItems([item]).length === 0) break
          }
          if (!item || activeItems([item]).length)
            throw new Error('Download cancellation is still in progress; retry remove shortly.')
        }
        if (trashFile && item.status.toLowerCase() === 'completed' && existsSync(item.destination))
          await shell.trashItem(item.destination)
        await control({ command: 'remove', id })
        sendHistoryChanged()
        void emitSnapshot()
        return { removed: true, id, trashFile }
      }
      case 'open':
      case 'reveal': {
        if (!id) throw new Error('Provide --id <download-id>.')
        const native = await nativeUpdates()
        if (
          native.some((entry) => entry.state.id === id) ||
          (await nativeHistory()).some((entry) => entry.id === id)
        ) {
          const success =
            command === 'open' ? await torrentManager.open(id) : await torrentManager.reveal(id)
          return { id, success }
        }
        const item = (await externalQueue()).find((entry) => entry.id === id)
        if (!item || !existsSync(item.destination)) return { id, success: false }
        if (command === 'open')
          return { id, success: (await shell.openPath(item.destination)) === '' }
        shell.showItemInFolder(item.destination)
        return { id, success: true }
      }
      case 'interfaces':
      case 'networks':
        return torrentNetworks.refresh()
      case 'network-usage':
        await torrentManager.limits.loaded
        return { native: torrentManager.limits.usedByPeriod() }
      case 'network-reset':
      case 'reset-network-usage': {
        const networkId = textOf('id', 'networkId', 'network-id')
        if (!networkId) throw new Error('Provide --id <network-id>.')
        if (!interfaces().some((entry) => entry.id === networkId))
          throw new Error('The selected network interface is no longer available.')
        await torrentManager.resetNetworkUsage(networkId)
        return { id: networkId, reset: true }
      }
      case 'network-pref': {
        const networkId = textOf('id', 'networkId', 'network-id')
        if (!networkId) throw new Error('Provide --id <network-id>.')
        const current = effectiveSettings().networkPreferences ?? {}
        const preference = { ...(current[networkId] ?? {}) }
        const off =
          request.off ?? (request.enabled !== undefined ? !parseOnOff(request.enabled) : undefined)
        if (off !== undefined) {
          const parsed = parseOnOff(off)
          if (parsed === undefined) throw new Error('--off must be on or off.')
          if (parsed) preference.off = true
          else delete preference.off
        }
        const customName = textOf('name', 'customName', 'custom-name')
        if (customName !== undefined) preference.customName = customName
        const colorId = textOf('color', 'colorId', 'color-id')
        if (colorId !== undefined) preference.colorId = colorId
        const speedLimit = request.networkSpeedLimit ?? request['network-speed-limit']
        if (speedLimit !== undefined) preference.speedLimit = rateToBytes(speedLimit, request.unit)
        const dataLimit = request.dataLimitBytes ?? request['data-limit-bytes']
        if (dataLimit !== undefined) {
          const bytes = Number(dataLimit)
          if (!Number.isSafeInteger(bytes) || bytes <= 0)
            throw new Error('Data limit must be a positive whole number of bytes.')
          preference.dataLimit = bytes
        }
        const period = textOf('period', 'dataLimitPeriod', 'data-limit-period')
        if (period) {
          if (!['day', 'week', 'month'].includes(period))
            throw new Error('Data limit period must be day, week, or month.')
          preference.dataLimitPeriod = period as 'day' | 'week' | 'month'
        }
        const next = { ...current, [networkId]: preference }
        return updateSettings({ networkPreferences: next })
      }
      case 'download-network': {
        if (!id) throw new Error('Provide --id <download-id>.')
        const networkId = textOf('networkId', 'network-id')
        if (!networkId) throw new Error('Provide --network-id <network-id>.')
        const enabled = parseOnOff(request.enabled ?? request.value)
        if (enabled === undefined) throw new Error('--enabled must be on or off.')
        const native = await nativeUpdates()
        if (native.some((entry) => entry.state.id === id)) {
          await torrentManager.setNetworkEnabled(id, networkId, enabled)
        } else {
          const all = interfaces()
          const target = all.find((entry) => entry.id === networkId)
          if (!target) throw new Error('Network interface not found: ' + networkId)
          const existing = (await externalQueue()).find((entry) => entry.id === id)
          if (!existing) throw new Error('Download not found: ' + id)
          const targetAddresses = target.addresses
            .filter((address) => address.family === 4)
            .map((address) => address.address)
          if (!targetAddresses.length) throw new Error('Network has no usable IPv4 address.')
          const selected = new Set(existing.sourceAddresses ?? [])
          if (enabled) for (const address of targetAddresses) selected.add(address)
          else for (const address of targetAddresses) selected.delete(address)
          await control({ command: 'set-networks', id, sourceAddresses: [...selected] })
        }
        void emitSnapshot()
        return { id, networkId, enabled }
      }
      case 'torrent-files': {
        if (!id) throw new Error('Provide --id <download-id>.')
        return torrentManager.torrentFiles(id)
      }
      case 'choose-torrent-files': {
        if (!id) throw new Error('Provide --id <download-id>.')
        const files = parseIndexes(request.files ?? request.selectedFiles)
        if (!files) throw new Error('Provide --files 0,1,2.')
        await torrentManager.chooseTorrentFiles(id, files)
        void emitSnapshot()
        return { id, selectedFiles: files }
      }
      case 'links':
      case 'links-list':
        return pendingLinks()
      case 'link-dismiss': {
        const linkId = textOf('id', 'linkId', 'link-id')
        if (!linkId) throw new Error('Provide --id <link-id>.')
        releaseLink(linkId)
        return { dismissed: true, id: linkId }
      }
      case 'link-resume': {
        const linkId = textOf('linkId', 'link-id')
        const downloadId = textOf('downloadId', 'download-id', 'id')
        if (!linkId || !downloadId)
          throw new Error('Provide --link-id <link-id> --download-id <download-id>.')
        const offer = pendingLink(linkId)
        if (!offer?.probe || offer.probe.kind !== 'http')
          throw new Error('That pending link is no longer available as a direct web download.')
        await torrentManager.relink(downloadId, offer.probe.finalUrl, {
          probe: offer.probe,
          browser: offer.browser
        })
        releaseLink(linkId)
        void emitSnapshot()
        return { resumed: true, id: downloadId }
      }
      case 'window': {
        const action = (textOf('action', 'value') ?? '').toLowerCase()
        const window = BrowserWindow.getAllWindows()[0]
        if (!window || window.isDestroyed()) throw new Error('Sonic window is not available.')
        if (action === 'minimize') window.minimize()
        else if (action === 'maximize')
          window.isMaximized() ? window.unmaximize() : window.maximize()
        else if (action === 'show' || action === 'restore') {
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        } else if (action === 'close') window.close()
        else throw new Error('Window action must be minimize, maximize, show, or close.')
        return { action, success: true }
      }
      case 'free-space': {
        const path = textOf('path', 'destinationDir')
        if (!path) throw new Error('Provide --path <folder>.')
        try {
          const stats = await statfs(resolve(path))
          return { path: resolve(path), freeBytes: stats.bavail * stats.bsize }
        } catch {
          return { path: resolve(path), freeBytes: null }
        }
      }
      case 'clipboard':
        return { text: clipboard.readText() }
      default:
        throw new Error(
          'Unknown command: ' + command + '. Run SpeedOFreq.Cli.exe --help for supported commands.'
        )
    }
  }
  startCliControlServer(dispatchControl)
  configureRemoteControl(dispatchControl)
  handle(C.remoteControlState, async () => loadRemoteControlState(interfaces()))
  handle(C.enableRemoteControl, async (interfaceId: string) =>
    enableRemoteControl(interfaceId, interfaces())
  )
  handle(C.disableRemoteControl, async () => disableRemoteControl())
  handle(
    C.createRemotePairingCode,
    async (scopes: import('../shared/types').RemoteControlScope[]) =>
      createRemotePairingCode(scopes)
  )
  handle(C.revokeRemoteDevice, async (deviceId: string) => revokeRemoteDevice(deviceId))
  handle(C.exportRemoteCaCertificate, async () => exportRemoteCaCertificate())
  await startBridge({
    manager: { failedMatch: () => undefined } as unknown as DownloadManager,
    offer: (offer) => offerLink(offer, BrowserWindow.getAllWindows()[0] ?? null)
  })
  poller = setInterval(() => void emitSnapshot(), 900)
  void emitSnapshot()
}
export async function waitForSonicBackend(): Promise<void> {
  await control({ command: 'status' })
}

/** Headless LAN mode requires an explicit startup flag and a previously selected Wi-Fi interface. */
export async function startHeadlessRemoteControl(interfaceId?: string): Promise<void> {
  const currentState = await loadRemoteControlState(interfaces())
  if (
    !currentState.caFingerprint ||
    !currentState.devices.some(
      (device) => !device.revoked && device.createdAt + 24 * 60 * 60_000 > Date.now()
    )
  ) {
    throw new Error(
      'Run Sonic normally once, enable local Wi-Fi remote control, export/install its CA certificate, and pair your phone before starting headless remote mode.'
    )
  }
  const selected = interfaceId?.trim() || (await preferredRemoteInterfaceId())
  if (!selected) {
    throw new Error(
      'No Wi-Fi interface is saved. Select a Wi-Fi interface in Sonic before starting headless remote mode.'
    )
  }
  await enableRemoteControl(selected, interfaces())
}

export function stopSonicBridge(): void {
  stopRemoteControl()
  stopCliControlServer()
  if (poller) clearInterval(poller)
  poller = null
  if (backend && !backend.killed) backend.kill()
  backend = null
}
