import { trashDownload } from './trashDownload'
import { describeError } from '../../shared/errors'
import { randomUUID } from 'node:crypto'
import { copyFile, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import type { BrowserWindow } from 'electron'
import { app, powerSaveBlocker, safeStorage, shell } from 'electron'
import { showCompletionToast } from '../completionNotification'
import { scheduleWindow } from '../../shared/downloadSchedule'
import { IpcChannels } from '../../shared/ipc-channels'
import {
  DOWNLOADS_AT_ONCE,
  SPEED_HISTORY_SECONDS,
  type AppSettings,
  type CompletionAction,
  type BrowserContext,
  type DownloadSchedule,
  type DownloadNetwork,
  type DownloadState,
  type DownloadStatus,
  type DownloadUnitState,
  type DownloadUpdate,
  type FinishedDownload,
  type HttpBlockState,
  type HttpDownloadNetwork,
  type HttpDownloadState,
  type NetworkInterfaceInfo,
  type NetworkStatus,
  type HttpProbeResult,
  type StartDownloadRequest,
  type StartHttpDownloadRequest,
  type StartTorrentDownloadRequest,
  type TorrentDownloadNetwork,
  type TorrentDownloadState,
  type TorrentFileEntry,
  type TorrentInfo,
  type TorrentPieceState
} from '../../shared/types'
import { Limits } from '../network/limits'
import { loadSettings } from '../settings'
import { addToHistory, findInHistory, markHistoryRemoved, removeFromHistory } from './history'
import { hashCompletedOutput } from './outputHash'
import { testKnobs } from '../testKnobs'
import { DownloadFile } from './downloadFile'
import { compareSamples, HttpTransfer, pickedStreams, splittable } from './httpTransfer'
import { FtpTransfer } from './ftpTransfer'
import { parseFtpResource } from './ftpProtocol'
import { normalizeEtag } from './fileVersion'
import { ensureDirectory, pathExists, reserveDestinationPath } from './paths'
import { planBlocks, planDownload, planPieces } from './plan'
import { restoreBlocks, restorePieces, saveBlocks, type SavedBlocks } from './savedProgress'
import { chosenFiles, finishedFiles, wantedPieces } from './torrent/files'
import { probeUrl } from './probe'
import { browserContextFrom } from './browserContext'
import { describeTorrent, probedTorrentFile } from './torrent/metadata'
import { TorrentDestination } from './torrent/torrentDestination'
import { TorrentTransfer } from './torrent/torrentTransfer'
import { TorrentPreviewServer } from './torrentPreview'
import { HttpMediaPreviewServer } from './httpMediaPreview'
import {
  clearSpeeds,
  delay,
  Meters,
  recomputeAggregates,
  updateSpeeds,
  updateTimeLeft,
  type Transfer,
  type TransferHost,
  type HttpTransferTarget,
  type TorrentTransferTarget
} from './transfer'
import type { NetworkMonitor } from '../network/interfaces'
import {
  compatibleInterfaces,
  NoCompatibleRouteError,
  resolveTargetWithin,
  targetHost,
  StreamConnection,
  routesFor
} from '../network/routes'

interface RuntimeFields {
  publicationPath?: string
  publicationIdentity?: { dev: number; ino: number }
  runPromise?: Promise<void>
  cancelPromise?: Promise<void>
  scheduleStopping?: boolean
  publishing: boolean
  pushScheduled: boolean
  persistenceTimer?: NodeJS.Timeout
  /** A routine checkpoint waits its turn: it will save whatever has changed by then. */
  checkpointQueued?: boolean
  persistenceChain: Promise<void>
  removed: boolean
  /** Updates sent to the window so far (see DownloadUpdate). */
  sentUpdates: number
  /** Each block as the window was last sent it, by index — what tells a changed block apart. */
  sentUnits: (Pick<DownloadUnitState, 'status' | 'interfaceId' | 'bytesDownloaded'> & {
    provisionalBytes?: number
  })[]
  /** The network most recently switched off: what a resume switches back on if it finds none on.
   * Not persisted: after a restart, the first network present is used instead. */
  lastSwitchedOff?: string
  /** Paused by switching off its last network, rather than by Pause: switching one back on
   * resumes it. */
  pausedForNoNetwork?: boolean
  /** When the speeds last went into the history (see sampleSpeeds). */
  speedSampledAt: number
  /** The byte count, read once a second while downloading and carried over pauses: back to the
   * newest reading PEAK_SECONDS old (see samplePeak). */
  peakReadings: { time: number; bytes: number }[]
  /** Changes asked of a torrent's choice of files, counted: only the latest applies. */
  fileChoices: number
}

interface HttpDownloadRuntime extends RuntimeFields, HttpTransferTarget {
  kind: 'http'
  transfer: Transfer
}

interface TorrentDownloadRuntime extends RuntimeFields, TorrentTransferTarget {
  kind: 'torrent'
  transfer: TorrentTransfer
}

type DownloadRuntime = HttpDownloadRuntime | TorrentDownloadRuntime

interface PersistedDownloadBase {
  savedAt: number
  partialPath: string
  publicationPath?: string
  publicationIdentity?: { dev: number; ino: number }
  requestPayload: StartDownloadRequest
  /** Kept apart from requestPayload, sealed (see sealBrowser). */
  browser?: string
  /** FTP credentials are never serialized in the clear. */
  sealedFtpCredentials?: string
}

type PersistedState =
  Omit<HttpDownloadState, 'blocks' | 'streams'> | Omit<TorrentDownloadState, 'pieces' | 'peers'>

type PersistedDownload = PersistedDownloadBase & {
  version: 7
  state: PersistedState
} & SavedBlocks

/** Cookies are never written in the clear. Without a keychain (Linux falls back to a fixed key)
 * they aren't saved at all, and a download resumed after a restart goes without them. */
function sealBrowser(browser: BrowserContext): string | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    return undefined
  }
  // The keychain can refuse; the download is still saved, it just won't keep the sign-in.
  try {
    return safeStorage.encryptString(JSON.stringify(browser)).toString('base64')
  } catch {
    return undefined
  }
}

function unsealBrowser(sealed: string): BrowserContext | undefined {
  try {
    return (
      browserContextFrom(JSON.parse(safeStorage.decryptString(Buffer.from(sealed, 'base64')))) ??
      undefined
    )
  } catch {
    return undefined
  }
}

function sealFtpCredentials(credentials: {
  username: string
  password: string
}): string | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    return undefined
  try {
    return safeStorage.encryptString(JSON.stringify(credentials)).toString('base64')
  } catch {
    return undefined
  }
}

function unsealFtpCredentials(sealed: string): { username: string; password: string } | undefined {
  try {
    const value: unknown = JSON.parse(safeStorage.decryptString(Buffer.from(sealed, 'base64')))
    if (
      !isRecord(value) ||
      typeof value.username !== 'string' ||
      typeof value.password !== 'string'
    )
      return undefined
    return { username: value.username, password: value.password }
  } catch {
    return undefined
  }
}

/** A finished download drops credentials: nothing will ask the server for it again. */
function savedRequest(
  runtime: DownloadRuntime
): Pick<PersistedDownloadBase, 'requestPayload' | 'browser' | 'sealedFtpCredentials'> {
  if (runtime.kind !== 'http') return { requestPayload: runtime.requestPayload }
  const { browser, ftpCredentials, ...requestPayload } = runtime.requestPayload
  const keepSecrets = runtime.state.status !== 'completed'
  return {
    requestPayload,
    ...(browser && { browser: keepSecrets ? sealBrowser(browser) : undefined }),
    ...(ftpCredentials && {
      sealedFtpCredentials: keepSecrets ? sealFtpCredentials(ftpCredentials) : undefined
    })
  }
}

const UI_UPDATE_MS = 200
/** How often a running download takes stock (see run). */
const TICK_MS = 500
// Syncing a growing file can briefly monopolize a slow destination drive. Keep recovery
// checkpoints independent of UI updates; pause and publication still force an immediate sync.
const CHECKPOINT_INTERVAL_MS = 15_000

// The peak is the best speed held this many seconds: longer than a start's burst (an ISP's burst
// allowance, every connection ramping up at once), which isn't the line's speed.
const PEAK_SECONDS = 5

/** Adds each network's speed to the download's history, and 0 for one no longer listed. A
 * network seen for the first time starts at 0 too, so every series is as long as the others and
 * lines up with them. */
function sampleSpeeds(state: DownloadState): void {
  const history = (state.speedHistory ??= {})
  const length = Object.values(history)[0]?.length ?? 0
  for (const network of state.networks) {
    history[network.id] ??= new Array<number>(length).fill(0)
  }
  for (const [id, series] of Object.entries(history)) {
    series.push(state.networks.find((network) => network.id === id)?.speedBytesPerSec ?? 0)
    if (series.length > SPEED_HISTORY_SECONDS) series.shift()
  }
}

/** Raises the peak to the last PEAK_SECONDS of downloading, read from the bytes themselves: what
 * AVG is made of, so the peak can't read below it (an average is never above its best stretch).
 * Read off the speed meters instead, it missed the opening burst AVG counts, and early on read
 * lower. The first stretch starts with the download, so a burst is in it, spread over the seconds,
 * not a speed. Readings run on across a pause (see run), so short runs between pauses count too. */
function samplePeak(runtime: DownloadRuntime, now: number): void {
  const { state } = runtime
  const readings = runtime.peakReadings
  readings.push({ time: now, bytes: state.bytesDownloaded })
  // Back to the newest reading at least PEAK_SECONDS old, by time rather than by count: a run that
  // stops between ticks adds a reading, and counted, a short stretch passed for a full one.
  while (readings.length > 1 && readings[1].time <= now - PEAK_SECONDS * 1000) readings.shift()
  const first = readings[0]
  if (now - first.time < PEAK_SECONDS * 1000) return
  const held = (state.bytesDownloaded - first.bytes) / ((now - first.time) / 1000)
  // Stretches are only read where a reading falls, so the download's first or last few seconds
  // can go unread as one — and when those were its fastest, every stretch read is slower than the
  // average. Its best 5 seconds can't be, though: past PEAK_SECONDS of downloading, the average
  // (as AVG works it out) is a floor the peak truly clears.
  const downloading = (now - state.startedAt - (state.totalPausedMs ?? 0)) / 1000
  const average = downloading >= PEAK_SECONDS ? state.bytesDownloaded / downloading : 0
  state.peakSpeedBytesPerSec = Math.max(state.peakSpeedBytesPerSec ?? 0, held, average)
}

function newHttpNetwork(iface: NetworkInterfaceInfo, enabled: boolean): HttpDownloadNetwork {
  return {
    transfer: 'http',
    id: iface.id,
    label: iface.displayName,
    kind: iface.kind,
    enabled,
    status: enabled ? 'on' : 'off',
    bytesDownloaded: 0,
    speedBytesPerSec: 0,
    retries: 0
  }
}

function newTorrentNetwork(iface: NetworkInterfaceInfo, enabled: boolean): TorrentDownloadNetwork {
  return {
    ...newHttpNetwork(iface, enabled),
    transfer: 'torrent',
    bytesUploaded: 0,
    uploadSpeedBytesPerSec: 0
  }
}

/** A block that needs nothing more: in, or skipped (see BlockStatus). */
const isDone = (unit: DownloadUnitState): boolean =>
  unit.status === 'completed' || unit.status === 'skipped'

const unitsOf = (runtime: DownloadRuntime): DownloadUnitState[] =>
  runtime.kind === 'http' ? runtime.blocks : runtime.pieces

/** A torrent download's files as its state shows them, given those `chosen` (null: every one). */
function choiceOf(chosen: Set<number> | null, total: number): TorrentDownloadState['files'] {
  const selected = chosen ? [...chosen].sort((a, b) => a - b) : undefined
  return { chosen: selected?.length ?? total, total, selected }
}

/** Sets each piece of `torrent` by whether a `chosen` file (null: every one) needs it: skipped
 * when none does, waiting again when one does. A piece that's in stays in, needed or not. The
 * skipped pieces' bytes, all together. As a download starts, comes back, or its choice changes. */
function choosePieces(
  pieces: TorrentPieceState[],
  torrent: TorrentInfo,
  chosen: Set<number> | null
): number {
  const wanted = chosen && wantedPieces(torrent.files, torrent.pieceLength, chosen)
  let skipped = 0
  for (const piece of pieces) {
    if (piece.status === 'completed' || piece.rangeEnd === null) continue
    if (!wanted || wanted[piece.index]) {
      if (piece.status === 'skipped') piece.status = 'pending'
      continue
    }
    piece.status = 'skipped'
    piece.provisionalBytes = 0
    skipped += piece.rangeEnd - piece.rangeStart + 1
  }
  return skipped
}

/** The files not `chosen`, as the torrent names them. */
function unchosenPaths(torrent: TorrentInfo, chosen: Set<number> | null): string[] {
  return chosen
    ? torrent.files.filter((_, index) => !chosen.has(index)).map((file) => file.path)
    : []
}

const isNotFound = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'

/** A manifest this version writes, for the download in folder `id`. */
function isCurrentManifest(value: unknown, id: string): value is PersistedDownload {
  const manifest = value as Partial<PersistedDownload> | null
  return manifest?.version === 7 && manifest.state?.id === id
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSavedCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Upgrade the immediately preceding manifest format only when its checkpoint layout is
 * compatible with today's restoration code. Older/incomplete layouts stay untouched on disk.
 * In particular, a version number alone is never enough to authorize a migration.
 */
function normalizePersistedManifest(value: unknown, id: string): PersistedDownload | undefined {
  if (isCurrentManifest(value, id)) return value
  if (!isRecord(value) || value.version !== 6 || !isRecord(value.state)) return undefined

  const state = value.state
  const request = value.requestPayload
  const progress = value.progress
  if (
    state.id !== id ||
    (state.kind !== 'http' && state.kind !== 'torrent') ||
    !isRecord(request) ||
    request.kind !== state.kind ||
    typeof request.url !== 'string' ||
    typeof request.destinationDir !== 'string' ||
    typeof request.suggestedFileName !== 'string' ||
    typeof value.savedAt !== 'number' ||
    !Number.isFinite(value.savedAt) ||
    typeof value.partialPath !== 'string' ||
    value.partialPath.length === 0 ||
    typeof state.status !== 'string' ||
    typeof state.destinationPath !== 'string' ||
    typeof state.fileName !== 'string' ||
    !isSavedCount(state.totalBytes) ||
    !isSavedCount(state.bytesDownloaded) ||
    !Array.isArray(state.networks) ||
    !isRecord(progress) ||
    !Object.values(progress).every(
      (column) => Array.isArray(column) && column.every(isSavedCount)
    ) ||
    typeof value.complete !== 'boolean'
  ) {
    return undefined
  }

  if (state.kind === 'http') {
    if (
      !isSavedCount(state.blockSizeBytes) ||
      state.blockSizeBytes === 0 ||
      !isSavedCount(state.totalBlocks) ||
      state.totalBlocks === 0
    ) {
      return undefined
    }
  } else if (
    !isSavedCount(state.pieceLength) ||
    state.pieceLength === 0 ||
    !isSavedCount(state.totalPieces) ||
    state.totalPieces === 0
  ) {
    return undefined
  }

  return { ...(value as unknown as PersistedDownload), version: 7 }
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

/** The staging file is on the destination volume and becomes the final file by rename. */
async function ensureDiskSpace(destinationDir: string, requiredBytes: number): Promise<void> {
  if (requiredBytes <= 0) return // unknown size — nothing to check against
  const stats = await statfs(destinationDir)
  const availableBytes = stats.bavail * stats.bsize
  if (availableBytes < requiredBytes) {
    throw new Error(
      `Not enough disk space: this download needs ${formatGigabytes(requiredBytes)} but only ${formatGigabytes(availableBytes)} is free`
    )
  }
}

export class DownloadManager {
  private runtimes = new Map<string, DownloadRuntime>()
  private readonly torrentPreview = new TorrentPreviewServer((id, fileIndex) => {
    const runtime = this.runtimes.get(id)
    if (runtime?.kind !== 'torrent') throw new Error('This download is not an active torrent.')
    return runtime.transfer.previewFile(fileIndex)
  })
  private readonly httpMediaPreview = new HttpMediaPreviewServer((id) => {
    const runtime = this.runtimes.get(id)
    if (runtime?.kind !== 'http' || runtime.state.status !== 'downloading') {
      throw new Error('HTTP media preview is available only while the download is active.')
    }
    if (runtime.requestPayload.mediaStream) {
      throw new Error(
        'Live preview is for direct HTTP media files, not HLS/DASH streams handled by FFmpeg.'
      )
    }
    const extension = runtime.state.fileName
      .slice(runtime.state.fileName.lastIndexOf('.'))
      .toLowerCase()
    const types: Record<string, string> = {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.m4v': 'video/x-m4v',
      '.mov': 'video/quicktime',
      '.mp3': 'audio/mpeg',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.oga': 'audio/ogg',
      '.opus': 'audio/ogg'
    }
    const contentType = types[extension]
    if (!contentType)
      throw new Error(
        'Preview supports MP4, WebM, M4V, MOV, MP3, M4A, AAC, WAV, OGG and Opus files.'
      )
    // Only expose the contiguous prefix that the download engine confirms as written. Multi-stream
    // downloads can have sparse holes later in the file; never serve those as media bytes.
    let availableBytes = 0
    for (const block of [...runtime.state.blocks].sort((a, b) => a.rangeStart - b.rangeStart)) {
      if (block.rangeStart !== availableBytes) break
      availableBytes += block.bytesDownloaded
      if (block.status !== 'completed') break
      if (block.rangeEnd !== null && availableBytes < block.rangeEnd + 1) break
    }
    return {
      path: runtime.file.path,
      totalBytes: runtime.state.totalBytes,
      availableBytes,
      status: runtime.state.status,
      contentType
    }
  })
  private readonly recoveryIssuesById = new Map<
    string,
    { id: string; message: string; manifestPath: string }
  >()
  /** Downloads whose new link is being checked: two at once could both pass and both resume. */
  private relinking = new Set<string>()
  private readonly initialization: Promise<void>
  private suspending = false
  private scheduleLoaded = false
  private downloadSchedule?: DownloadSchedule
  private scheduleTimer?: NodeJS.Timeout
  /** Each network's addresses as last seen, by id: what tells a network that has changed. */
  private seenAddresses = new Map<string, string[]>()
  /** The powerSaveBlocker keeping the computer awake while a download runs (see keepAwake). */
  private awakeBlocker: number | null = null
  /** How many downloads may run at once; the rest wait, queued (see pump). */
  private downloadsAtOnce = DOWNLOADS_AT_ONCE.default
  /** Active work owned by the legacy bridge or media manager, counted against the same slot limit. */
  private externalRunningCount = 0
  /** Speed and data limits, for every download together. */
  readonly limits = new Limits(() => this.limitsChanged())

  constructor(
    private getWindow: () => BrowserWindow | null,
    private networks: NetworkMonitor,
    private getCompletionAction: () => CompletionAction = () => 'notify'
  ) {
    this.initialization = Promise.all([this.restorePersistedDownloads(), this.limits.loaded]).then(
      async () => {
        // Read after recovery, including any settings saved while the manifests were loading.
        await this.configureSettings(await loadSettings())
      }
    )
  }

  /** Takes up what the user set: how many run at once, and the limits. One running past a
   * lowered count is left to finish; a raised one starts the next ones in the queue. */
  async applySettings(settings: AppSettings): Promise<void> {
    await this.initialization
    await this.configureSettings(settings)
  }

  private async configureSettings(settings: AppSettings): Promise<void> {
    this.downloadSchedule = settings.downloadSchedule
    this.scheduleLoaded = true
    const enrollmentChanged: DownloadRuntime[] = []
    const scheduled = this.downloadSchedule?.enabled || undefined
    for (const runtime of this.runtimes.values()) {
      // Global speed limits live in Limits. Per-task receive and upload caps are explicit user
      // choices stored in each manifest, so loading settings must not erase either one.
      if (
        (runtime.state.status === 'queued' || runtime.state.status === 'downloading') &&
        runtime.state.scheduled !== scheduled
      ) {
        runtime.state.scheduled = scheduled
        enrollmentChanged.push(runtime)
        this.pushUpdate(runtime)
      }
    }
    this.downloadsAtOnce = settings.downloadsAtOnce ?? DOWNLOADS_AT_ONCE.default
    this.limits.configure(settings)
    await this.refreshSchedule()
    this.limitsChanged()
    await Promise.all(enrollmentChanged.map((runtime) => this.persistNow(runtime)))
    this.armScheduleTimer()
  }

  /** A network ran out of data, or a limit changed: each download's networks are looked at
   * again, so one at its limit stops being used, and one no longer at it is used again. */
  async resetNetworkUsage(id: string): Promise<void> {
    await this.limits.resetUsage(id)
    this.limitsChanged()
  }

  private limitsChanged(): void {
    for (const runtime of this.runtimes.values()) {
      const { status } = runtime.state
      if (status !== 'downloading' && status !== 'paused' && status !== 'queued') continue
      this.reconcile(runtime)
      this.scheduleUpdate(runtime)
    }
  }

  private armScheduleTimer(): void {
    clearTimeout(this.scheduleTimer)
    if (this.suspending || !this.downloadSchedule?.enabled) return
    // Check the clock as well as exact boundaries, including timezone changes while running.
    const now = Date.now()
    const window = scheduleWindow(this.downloadSchedule, now)
    const boundary = window.allowed ? window.endsAt : window.nextStart
    this.scheduleTimer = setTimeout(
      () => {
        void this.refreshSchedule()
          .catch((error) => console.error('[Sonic] schedule', error))
          .finally(() => this.armScheduleTimer())
      },
      boundary ? Math.max(1, Math.min(1000, boundary - now)) : 1000
    )
    this.scheduleTimer.unref()
  }

  private scheduleAllowsDownloads(): boolean {
    return this.scheduleLoaded && scheduleWindow(this.downloadSchedule).allowed
  }

  /** Close transfers before the queue can start anything else. The queued intent is persisted,
   * so a scheduled download can continue next night after a relaunch. */
  private async refreshSchedule(): Promise<void> {
    if (this.suspending) return
    if (!this.scheduleAllowsDownloads()) {
      await Promise.all(
        [...this.runtimes.values()].map((runtime) =>
          runtime.state.status === 'downloading' || runtime.scheduleStopping
            ? this.pause(runtime.state.id, true)
            : undefined
        )
      )
    } else {
      this.pump()
    }
  }

  /** Running downloads on Auto with `networkId` on: how many share its streams (see
   * concurrency.ts). One that can't split runs a single stream, and a picked count is kept, so
   * neither takes a share. */
  private httpDownloadsOn(networkId: string): number {
    let count = 0
    for (const runtime of this.runtimes.values()) {
      if (
        runtime.kind === 'http' &&
        runtime.state.status === 'downloading' &&
        splittable(runtime.requestPayload) &&
        pickedStreams(runtime.requestPayload) === undefined &&
        runtime.state.networks.some(
          (network) => network.id === networkId && network.status === 'on'
        )
      )
        count++
    }
    return count
  }

  private runningCount(): number {
    let running = 0
    for (const runtime of this.runtimes.values()) {
      if (runtime.state.status === 'downloading') running++
    }
    return running
  }

  /** Updates slots occupied by other managed download types, then repumps the native queue. */
  setExternalRunningCount(count: number): void {
    this.externalRunningCount = Number.isSafeInteger(count) ? Math.max(0, count) : 0
    this.pump()
  }

  /** Whether another non-native task may start under the shared schedule and concurrency policy. */
  async canStartExternalDownload(): Promise<boolean> {
    await this.initialization
    return (
      !this.suspending &&
      this.scheduleAllowsDownloads() &&
      this.runningCount() + this.externalRunningCount < this.downloadsAtOnce
    )
  }

  /** Starts queued downloads, first queued first, while fewer than downloadsAtOnce run. Called
   * whenever one might have room: a run ended, a queued one went, the count went up. */
  private pump(): void {
    if (this.suspending || !this.scheduleAllowsDownloads()) return
    const queued = [...this.runtimes.values()]
      .filter((runtime) => runtime.state.status === 'queued' && !runtime.scheduleStopping)
      .sort(
        (a, b) =>
          (b.state.priority ?? 1) - (a.state.priority ?? 1) ||
          (a.state.queuedAt ?? 0) - (b.state.queuedAt ?? 0)
      )
    for (const runtime of queued) {
      if (this.runningCount() + this.externalRunningCount >= this.downloadsAtOnce) return
      this.begin(runtime)
    }
  }

  /** Puts a download in the queue: at its end, or at its front when the user asked for it. */
  private enqueue(runtime: DownloadRuntime, front: boolean): void {
    const places = [...this.runtimes.values()]
      .filter((other) => other !== runtime && other.state.status === 'queued')
      .map((other) => other.state.queuedAt ?? 0)
    runtime.state.status = 'queued'
    runtime.state.scheduled = this.downloadSchedule?.enabled || undefined
    // Time spent waiting isn't time spent downloading (begin adds it to totalPausedMs).
    runtime.state.pausedAt ??= Date.now()
    runtime.state.queuedAt = front
      ? Math.min(Date.now(), ...places) - 1
      : Math.max(Date.now(), ...places.map((place) => place + 1))
  }

  private downloadsRoot(): string {
    return join(app.getPath('userData'), 'downloads')
  }

  private downloadDir(id: string): string {
    return join(this.downloadsRoot(), id)
  }

  private manifestPath(id: string): string {
    return join(this.downloadDir(id), 'manifest.json')
  }

  /** Where a torrent download keeps its .torrent, beside its manifest. */
  private torrentFilePath(id: string): string {
    return join(this.downloadDir(id), 'metadata.torrent')
  }

  private runtimeFields(): RuntimeFields {
    return {
      publishing: false,
      pushScheduled: false,
      persistenceChain: Promise.resolve(),
      removed: false,
      sentUpdates: 0,
      sentUnits: [],
      speedSampledAt: 0,
      peakReadings: [],
      fileChoices: 0
    }
  }

  private newHttpRuntime(
    state: HttpDownloadState,
    requestPayload: StartHttpDownloadRequest,
    file: DownloadFile,
    blocks: HttpBlockState[]
  ): HttpDownloadRuntime {
    const target: HttpTransferTarget = {
      state,
      requestPayload,
      stop: new AbortController(),
      file,
      blocks,
      meters: new Meters()
    }
    const host: TransferHost = {
      networks: this.networks,
      limits: this.limits,
      downloadsOn: (networkId) => this.httpDownloadsOn(networkId),
      reconcile: () => this.reconcile(runtime),
      failDownload: (message, discard) => this.failDownload(runtime, message, discard),
      failNetwork: (network, message) => this.failNetwork(runtime, network, message),
      scheduleUpdate: () => this.scheduleUpdate(runtime)
    }
    const protocol = new URL(requestPayload.url).protocol
    let transfer: Transfer
    if (protocol === 'ftp:' || protocol === 'ftps:') {
      const iface = requestPayload.interfaceIds
        .map((id) => this.networks.find(id))
        .find((entry): entry is NetworkInterfaceInfo => entry !== undefined)
      const savedFamily = requestPayload.ftpLocalAddress?.includes(':') ? 6 : 4
      const currentAddress =
        iface?.addresses.find((address) => address.family === savedFamily)?.address ??
        iface?.addresses[0]?.address
      const localAddress = currentAddress ?? requestPayload.ftpLocalAddress
      if (!localAddress)
        throw new Error('No selected network address is available for the FTP connection.')
      requestPayload.ftpLocalAddress = localAddress
      transfer = new FtpTransfer(target, host, localAddress)
    } else {
      transfer = new HttpTransfer(target, host)
    }
    const runtime: HttpDownloadRuntime = Object.assign(target, this.runtimeFields(), {
      kind: 'http' as const,
      transfer
    })
    return runtime
  }

  private newTorrentRuntime(
    state: TorrentDownloadState,
    requestPayload: StartTorrentDownloadRequest,
    file: TorrentDestination,
    pieces: TorrentDownloadState['pieces'],
    torrentFile: Uint8Array
  ): TorrentDownloadRuntime {
    const target: TorrentTransferTarget = {
      state,
      requestPayload,
      stop: new AbortController(),
      file,
      pieces,
      meters: new Meters(),
      uploadMeters: new Meters()
    }
    const host: TransferHost = {
      networks: this.networks,
      limits: this.limits,
      downloadsOn: (networkId) => this.httpDownloadsOn(networkId),
      reconcile: () => this.reconcile(runtime),
      failDownload: (message, discard) => this.failDownload(runtime, message, discard),
      failNetwork: (network, message) => this.failNetwork(runtime, network, message),
      scheduleUpdate: () => this.scheduleUpdate(runtime)
    }
    const runtime: TorrentDownloadRuntime = Object.assign(target, this.runtimeFields(), {
      kind: 'torrent' as const,
      transfer: new TorrentTransfer(target, host, torrentFile, file.path)
    })
    return runtime
  }

  private noteRecoveryIssue(id: string, message: string): void {
    const issue = { id, message, manifestPath: this.manifestPath(id) }
    this.recoveryIssuesById.set(id, issue)
    console.warn(`[Sonic] Saved download ${id} needs recovery: ${message}`)
  }

  listRecoveryIssues(): { id: string; message: string; manifestPath: string }[] {
    return [...this.recoveryIssuesById.values()].map((issue) => ({ ...issue }))
  }

  /** Wait until startup recovery has finished before reporting its findings to the renderer. */
  async recoveryIssues(): Promise<{ id: string; message: string; manifestPath: string }[]> {
    await this.initialization
    return this.listRecoveryIssues()
  }

  private async restorePersistedDownloads(): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.downloadsRoot())
    } catch {
      return
    }

    const restored: DownloadRuntime[] = []
    await Promise.all(
      entries.map(async (id) => {
        const manifestPath = this.manifestPath(id)
        const temporaryPath = `${manifestPath}.tmp`
        let persisted: unknown
        let sourceVersion: unknown
        let loadedFromTemporary = false
        try {
          persisted = JSON.parse(await readFile(manifestPath, 'utf-8'))
          sourceVersion = isRecord(persisted) ? persisted.version : undefined
        } catch (mainError) {
          // A checkpoint is written to .tmp and then atomically renamed. If a crash interrupted
          // that rename, try the temp checkpoint before declaring the download unrecoverable.
          try {
            const temporaryRaw = JSON.parse(await readFile(temporaryPath, 'utf-8'))
            sourceVersion = isRecord(temporaryRaw) ? temporaryRaw.version : undefined
            const temporary = normalizePersistedManifest(temporaryRaw, id)
            if (!temporary) {
              this.noteRecoveryIssue(
                id,
                'The main manifest is missing or invalid, and its temporary checkpoint is not supported. Saved data was preserved.'
              )
              return
            }
            persisted = temporary
            loadedFromTemporary = true
          } catch (temporaryError) {
            const mainProblem =
              mainError instanceof SyntaxError
                ? 'the main manifest is malformed'
                : isNotFound(mainError)
                  ? 'the main manifest is missing'
                  : 'the main manifest could not be read'
            const temporaryProblem =
              temporaryError instanceof SyntaxError
                ? 'the temporary checkpoint is malformed'
                : isNotFound(temporaryError)
                  ? 'the temporary checkpoint is missing'
                  : 'the temporary checkpoint could not be read'
            this.noteRecoveryIssue(
              id,
              `${mainProblem}; ${temporaryProblem}. The manifest directory and downloaded data were preserved.`
            )
            return
          }
        }

        const normalized = normalizePersistedManifest(persisted, id)
        if (!normalized) {
          const version =
            typeof persisted === 'object' && persisted !== null && 'version' in persisted
              ? String((persisted as { version?: unknown }).version)
              : 'unknown'
          this.noteRecoveryIssue(
            id,
            `Saved manifest version ${version} is not supported by this build or its checkpoint layout is incompatible. The manifest, torrent metadata, and downloaded data were preserved.`
          )
          return
        }

        if (sourceVersion === 6) {
          const backupPath = `${manifestPath}.v6-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
          try {
            await copyFile(loadedFromTemporary ? temporaryPath : manifestPath, backupPath)
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            this.noteRecoveryIssue(
              id,
              `Version 6 migration was skipped because its backup could not be created (${reason}). The original checkpoint was preserved.`
            )
            return
          }
        }

        try {
          const runtime = await this.restoreOne(id, normalized)
          if (runtime) {
            restored.push(runtime)
            if (loadedFromTemporary) {
              console.info(`[Sonic] Recovered download ${id} from its temporary checkpoint.`)
            }
          } else {
            this.noteRecoveryIssue(
              id,
              'The saved state could not be matched to its partial file or torrent metadata. All remaining data was preserved.'
            )
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          this.noteRecoveryIssue(
            id,
            `The saved state could not be loaded (${reason}). All remaining data was preserved.`
          )
        }
      })
    )

    // Two runtimes must never write to the same partial file. Keep the newest in memory,
    // but preserve the other manifest and output instead of silently deleting a user's progress.
    restored.sort((a, b) => b.state.startedAt - a.state.startedAt)
    const claimed = new Set<string>()
    const kept: DownloadRuntime[] = []
    for (const runtime of restored) {
      const destinationKey = runtime.file.path.toLowerCase()
      if (claimed.has(destinationKey)) {
        this.noteRecoveryIssue(
          runtime.state.id,
          `Another saved download already claims ${runtime.file.path}. This item was not started to avoid concurrent writers; its saved data was preserved.`
        )
        continue
      }
      claimed.add(destinationKey)
      kept.push(runtime)
    }

    await Promise.all(
      kept.map(async (runtime) => {
        if (runtime.state.status === 'completed' && runtime.publicationIdentity) {
          const published = await stat(runtime.state.destinationPath).catch(() => null)
          if (
            published?.dev === runtime.publicationIdentity.dev &&
            published.ino === runtime.publicationIdentity.ino
          ) {
            await runtime.file.discardLeftover().catch(() => {})
          }
        }
        this.runtimes.set(runtime.state.id, runtime)
        // Finished before the relaunch (or found to be): history keeps it from here.
        if (runtime.state.status === 'completed') await this.moveToHistory(runtime)
        else await this.persistNow(runtime)
      })
    )
  }

  /** A finished download leaves the list of running ones for history, with its work units: a
   * download that is done needs none of them. Its saved state goes only once history has it. */
  private async moveToHistory(runtime: DownloadRuntime): Promise<void> {
    let entry: FinishedDownload
    if (runtime.kind === 'http') {
      const { blocks: omittedBlocks, streams: omittedStreams, ...state } = runtime.state
      void omittedBlocks
      void omittedStreams
      entry = { ...state, unitsWritten: state.totalBlocks }
    } else {
      const { pieces, peers: omittedPeers, ...state } = runtime.state
      void omittedPeers
      const written = pieces.filter((piece) => piece.status !== 'skipped').length
      const files = await this.torrentFiles(state.id)
      entry = {
        ...state,
        unitsWritten: written,
        downloadedFiles: files
          .filter((file) => file.chosen)
          .map((file) =>
            state.folder ? file.path.split(/[\\/]/).slice(1).join(sep) : basename(file.path)
          )
      }
    }
    // A digest is computed from the published output, not from a source-provided checksum. If
    // the output cannot be read for hashing, preserve the successful download in history anyway.
    try {
      const digest = await hashCompletedOutput(
        entry.destinationPath,
        entry.kind === 'torrent' && entry.folder ? entry.downloadedFiles : undefined
      )
      entry = { ...entry, sha256: digest.sha256, sha256Scope: digest.scope }
    } catch {
      // Hashing is best-effort; it must never turn a successfully published download into failure.
    }

    try {
      await addToHistory(structuredClone(entry))
    } catch {
      // Kept as it is, to be moved on the next launch.
      return
    }
    this.limits.forgetTask(runtime.state.id)
    this.runtimes.delete(runtime.state.id)
    await this.removePersistedDownload(runtime, false)
    this.historyChanged()
  }

  private historyChanged(): void {
    const window = this.getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IpcChannels.historyChanged)
  }

  /** Forgets every finished download. Their files are the user's: they stay. */
  async clearHistory(): Promise<void> {
    await this.initialization
    await Promise.allSettled(
      [...this.runtimes.values()]
        .filter((runtime) => runtime.state.status === 'completed')
        .map((runtime) => runtime.runPromise)
    )
    await removeFromHistory()
    this.historyChanged()
  }

  /** A saved download as this version writes it, restored paused — or null when it never can
   * be: its progress doesn't fit its plan, or a torrent's .torrent is gone. */
  private async restoreOne(
    id: string,
    persisted: PersistedDownload
  ): Promise<DownloadRuntime | null> {
    const requestPayload: StartDownloadRequest =
      persisted.requestPayload.kind === 'http'
        ? {
            ...persisted.requestPayload,
            ...(typeof persisted.browser === 'string' && {
              browser: unsealBrowser(persisted.browser)
            }),
            ...(typeof persisted.sealedFtpCredentials === 'string' && {
              ftpCredentials: unsealFtpCredentials(persisted.sealedFtpCredentials)
            })
          }
        : persisted.requestPayload
    const saved: SavedBlocks = { progress: persisted.progress, complete: persisted.complete }
    let state: DownloadState
    let runtime: DownloadRuntime
    if (persisted.state.kind === 'torrent' && requestPayload.kind === 'torrent') {
      const torrentFile = await readFile(this.torrentFilePath(id)).catch((error: unknown) => {
        if (isNotFound(error)) return null
        throw error
      })
      if (!torrentFile) return null
      const probe = await describeTorrent(torrentFile, requestPayload.url)
      if (probe.kind !== 'torrent') return null
      const { torrent } = probe
      const old = persisted.state
      const pieces = restorePieces(old, saved)
      if (!pieces) return null
      const chosen = chosenFiles(requestPayload.selectedFiles, torrent.files.length)
      state = {
        ...old,
        networks: old.networks.map((network) => ({ ...network, uploadSpeedBytesPerSec: 0 })),
        peers: [],
        pieces,
        totalPieces: pieces.length,
        pieceLength: torrent.pieceLength,
        files: choiceOf(chosen, torrent.files.length),
        // Seeding sessions do not silently resume after a process restart; the user can start a
        // fresh bounded session by setting a ratio before the next download completes.
        seeding: false,
        // Its pieces no chosen file needs are skipped again.
        skippedBytes: choosePieces(pieces, torrent, chosen),
        uploadSpeedBytesPerSec: 0
      }
      runtime = this.newTorrentRuntime(
        state,
        requestPayload,
        new TorrentDestination(
          persisted.partialPath,
          state.totalBytes,
          unchosenPaths(torrent, chosen),
          torrent.files.map((file) => file.path)
        ),
        pieces,
        torrentFile
      )
    } else if (persisted.state.kind === 'http' && requestPayload.kind === 'http') {
      const old = persisted.state
      const blocks = restoreBlocks(old, saved)
      if (!blocks) return null
      state = { ...old, streams: [], blocks, totalBlocks: blocks.length }
      runtime = this.newHttpRuntime(
        state,
        requestPayload,
        new DownloadFile(persisted.partialPath),
        blocks
      )
    } else {
      return null
    }
    const units = unitsOf(runtime)
    // Restore paused first so the partial file can be checked before scheduled work is queued.
    if (state.status === 'downloading' || state.status === 'queued') {
      state.status = 'paused'
      state.pausedAt = persisted.savedAt || Date.now()
      state.queuedAt = undefined
    }
    clearSpeeds(state)
    for (const unit of units) {
      if (unit.status === 'downloading') unit.status = 'pending'
      if (unit.kind === 'torrent') unit.provisionalBytes = 0
    }

    const file = runtime.file
    if (state.status === 'paused') {
      const size = await file.size().catch(() => -1)
      const publishedPath = persisted.publicationPath ?? state.destinationPath
      const published = await stat(publishedPath).catch(() => null)
      // A torrent's folder of files: its identity below is what tells it's this download's.
      const publishedSize = published?.isDirectory() ? state.totalBytes : (published?.size ?? -1)
      const expected = state.totalBytes || state.bytesDownloaded
      const sameFile =
        !!published &&
        (size >= 0
          ? await stat(file.path)
              .then((partial) => partial.dev === published.dev && partial.ino === published.ino)
              .catch(() => false)
          : persisted.publicationIdentity?.dev === published.dev &&
            persisted.publicationIdentity?.ino === published.ino)
      if (units.every(isDone) && publishedSize === expected && sameFile) {
        state.status = 'completed'
        state.destinationPath = publishedPath
        state.fileName = basename(publishedPath)
        state.error = undefined
        state.completedAt ??= persisted.savedAt
        if (size >= 0) await file.discardLeftover()
      } else if (size < 0) {
        state.status = 'error'
        state.error = 'The partial download file is missing. Remove this download and start again.'
        state.resumable = false
      } else {
        for (const unit of units) {
          const length = unit.rangeEnd === null ? 0 : unit.rangeEnd - unit.rangeStart + 1
          if (
            unit.rangeStart + unit.bytesDownloaded > size ||
            (unit.status === 'completed' && unit.bytesDownloaded !== length)
          ) {
            unit.status = 'pending'
            unit.bytesDownloaded = 0
            unit.bytesByInterface = {}
          }
        }
        state.bytesDownloaded = units.reduce((sum, unit) => sum + unit.bytesDownloaded, 0)
      }
    }

    if (state.status === 'paused' && state.scheduled === true) {
      state.status = 'queued'
      state.queuedAt = persisted.state.queuedAt ?? state.startedAt
    }

    runtime.publicationPath = persisted.publicationPath
    runtime.publicationIdentity = persisted.publicationIdentity
    // A resumed download's last minute starts when it does, not where it stopped before the
    // relaunch; a finished one keeps its chart.
    if (state.status !== 'completed') state.speedHistory = undefined
    recomputeAggregates(state, units)
    return runtime
  }

  /** A snapshot of every download: updates with every work unit in them, oldest first. */
  async listDownloads(): Promise<DownloadUpdate[]> {
    await this.initialization
    return [...this.runtimes.values()]
      .sort((a, b) => a.state.startedAt - b.state.startedAt)
      .map((runtime) => {
        if (runtime.kind === 'http') {
          const { blocks, ...state } = runtime.state
          return structuredClone({ seq: runtime.sentUpdates, state, blocks })
        }
        const { pieces, ...state } = runtime.state
        return structuredClone({ seq: runtime.sentUpdates, state, pieces })
      })
  }

  async start(requestPayload: StartDownloadRequest): Promise<string> {
    await this.initialization
    if (requestPayload.kind === 'http') {
      let incomingUrl: URL
      try {
        incomingUrl = new URL(requestPayload.url)
      } catch {
        throw new Error('Enter a valid download URL.')
      }
      if (incomingUrl.protocol === 'ftp:' || incomingUrl.protocol === 'ftps:') {
        const ftp = parseFtpResource(requestPayload.url)
        requestPayload = {
          ...requestPayload,
          url: ftp.safeUrl,
          ftpLocalAddress: requestPayload.ftpLocalAddress,
          ftpCredentialsRequired: ftp.credentialsRequired || requestPayload.ftpCredentialsRequired,
          ...(ftp.credentials && { ftpCredentials: ftp.credentials })
        }
      } else {
        if (incomingUrl.protocol !== 'http:' && incomingUrl.protocol !== 'https:') {
          throw new Error(
            'Only HTTP(S), FTP(S), magnet links and local .torrent files are supported.'
          )
        }
        if (incomingUrl.username || incomingUrl.password) {
          throw new Error(
            'HTTP(S) URLs must not contain embedded credentials. Use browser sign-in or a supported authenticated link flow.'
          )
        }
      }
      if (requestPayload.expectedSha256 && !/^[a-f0-9]{64}$/i.test(requestPayload.expectedSha256)) {
        throw new Error('The expected SHA-256 must contain exactly 64 hexadecimal characters.')
      }
    }
    if (requestPayload.kind === 'http' && requestPayload.mirrorUrls?.length) {
      if (requestPayload.mediaStream) throw new Error('Media streams do not support mirror URLs.')
      if (requestPayload.mirrorUrls.length > 5)
        throw new Error('Add no more than five alternate mirrors.')
      const strongEtag = requestPayload.etag
      const checksumTrusted = Boolean(requestPayload.expectedSha256)
      if ((!strongEtag || /^W\//i.test(strongEtag)) && !checksumTrusted) {
        throw new Error(
          'Mirrors require a strong ETag or a trusted Metalink SHA-256 checksum to verify file identity.'
        )
      }
      const verified: string[] = []
      for (const rawMirror of [
        ...new Set(requestPayload.mirrorUrls.map((value) => value.trim()))
      ]) {
        if (!rawMirror || rawMirror === requestPayload.url) continue
        let parsed: URL
        try {
          parsed = new URL(rawMirror)
        } catch {
          throw new Error(`Invalid mirror URL: ${rawMirror}`)
        }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
          throw new Error('Mirrors must be HTTP(S) URLs without embedded credentials.')
        }
        // Do not forward browser session cookies to alternate hosts; authenticated mirrors need a separate explicit design.
        const mirror = await probeUrl(parsed.toString())
        if (
          mirror.kind !== 'http' ||
          mirror.media ||
          mirror.totalBytes !== requestPayload.totalBytes ||
          !mirror.supportsRanges ||
          (!checksumTrusted && (mirror.etag !== strongEtag || /^W\//i.test(mirror.etag ?? '')))
        ) {
          throw new Error(
            'Mirror rejected: file length, range support, or strong ETag does not match the primary link.'
          )
        }
        verified.push(mirror.finalUrl)
      }
      requestPayload = { ...requestPayload, mirrorUrls: verified }
    }
    if (requestPayload.kind === 'http' && requestPayload.browser !== undefined) {
      const browser = browserContextFrom(requestPayload.browser)
      if (!browser) throw new Error('The browser’s details for this download couldn’t be read.')
      requestPayload = { ...requestPayload, browser }
    }

    const available = await this.networks.refresh()
    const selected = available.filter((iface) => requestPayload.interfaceIds.includes(iface.id))
    if (selected.length === 0) {
      throw new Error('Select at least one network')
    }
    await ensureDirectory(requestPayload.destinationDir)
    const id = randomUUID()
    let runtime: DownloadRuntime
    if (requestPayload.kind === 'torrent') {
      const torrentFile = probedTorrentFile(requestPayload.infoHash)
      if (!torrentFile) throw new Error('Add the torrent again to start downloading.')
      const torrentProbe = await describeTorrent(torrentFile, requestPayload.url)
      if (torrentProbe.kind !== 'torrent') throw new Error('Invalid torrent metadata')
      const torrent = torrentProbe.torrent
      const totalBytes = torrent.files.reduce((sum, entry) => sum + entry.length, 0)
      const chosen = chosenFiles(requestPayload.selectedFiles, torrent.files.length)
      const pieces = planPieces(totalBytes, torrent.pieceLength)
      const skippedBytes = choosePieces(pieces, torrent, chosen)
      await ensureDiskSpace(requestPayload.destinationDir, totalBytes - skippedBytes)
      const folder = torrent.files[0].path.includes(sep)
      const file = await TorrentDestination.create(
        requestPayload.destinationDir,
        requestPayload.suggestedFileName,
        folder,
        totalBytes,
        unchosenPaths(torrent, chosen),
        torrent.files.map((file) => file.path)
      )
      const destinationPath = file.path
      await ensureDirectory(this.downloadDir(id))
      await writeFile(this.torrentFilePath(id), torrentFile)
      const state: TorrentDownloadState = {
        id,
        kind: 'torrent',
        files: choiceOf(chosen, torrent.files.length),
        folder,
        url: requestPayload.url,
        fileName: basename(destinationPath),
        ...(requestPayload.packageName && { packageName: requestPayload.packageName }),
        destinationPath,
        totalBytes,
        skippedBytes,
        bytesDownloaded: 0,
        speedBytesPerSec: 0,
        bytesUploaded: 0,
        uploadSpeedBytesPerSec: 0,
        status: 'downloading',
        networks: available.map((iface) => newTorrentNetwork(iface, selected.includes(iface))),
        peers: [],
        peakPeers: 0,
        pieces,
        totalPieces: pieces.length,
        pieceLength: torrent.pieceLength,
        startedAt: Date.now()
      }
      runtime = this.newTorrentRuntime(state, requestPayload, file, pieces, torrentFile)
    } else {
      const target = new URL(requestPayload.url)
      const mirrorTargets = [requestPayload.url, ...(requestPayload.mirrorUrls ?? [])].map(
        (url) => new URL(url)
      )
      let usable = selected
      for (const mirrorTarget of mirrorTargets) {
        const reachable = compatibleInterfaces(
          selected,
          await resolveTargetWithin(targetHost(mirrorTarget), testKnobs.stallTimeoutMs)
        )
        usable = usable.filter((iface) => reachable.some((candidate) => candidate.id === iface.id))
      }
      if (usable.length === 0) throw new NoCompatibleRouteError(targetHost(target))
      const isFtp = target.protocol === 'ftp:' || target.protocol === 'ftps:'
      if (isFtp) {
        // FTP REST resumes one ordered stream; bind it to exactly one selected interface.
        const remoteAddresses = await resolveTargetWithin(
          targetHost(target),
          testKnobs.stallTimeoutMs
        )
        const routes = routesFor(usable[0], remoteAddresses)
        if (routes.length === 0) throw new NoCompatibleRouteError(targetHost(target))
        requestPayload = {
          ...requestPayload,
          interfaceIds: [usable[0].id],
          ftpLocalAddress: routes[0].localAddress
        }
        usable = [usable[0]]
      }
      const blockSizeBytes = isFtp
        ? Math.max(1, requestPayload.totalBytes)
        : planDownload({
            totalBytes: requestPayload.totalBytes,
            splittable: requestPayload.supportsRanges,
            networkCount: usable.length,
            maxBlockBytes: testKnobs.blockBytes
          }).blockSizeBytes
      const blocks: HttpBlockState[] = isFtp
        ? [
            {
              kind: 'http',
              index: 0,
              rangeStart: 0,
              rangeEnd: requestPayload.totalBytes > 0 ? requestPayload.totalBytes - 1 : null,
              bytesDownloaded: 0,
              bytesByInterface: {},
              status: 'pending'
            }
          ]
        : planBlocks(requestPayload.totalBytes, blockSizeBytes)
      await ensureDiskSpace(requestPayload.destinationDir, requestPayload.totalBytes)
      const destinationPath = await reserveDestinationPath(
        requestPayload.destinationDir,
        requestPayload.suggestedFileName
      )
      const networks = available.map((iface) => newHttpNetwork(iface, usable.includes(iface)))
      if (!splittable(requestPayload)) {
        for (const network of networks) network.enabled &&= network.id === usable[0].id
        for (const network of networks) network.status = network.enabled ? 'on' : 'off'
      }
      const state: HttpDownloadState = {
        id,
        kind: 'http',
        url: requestPayload.url,
        fileName: basename(destinationPath),
        ...(requestPayload.packageName && { packageName: requestPayload.packageName }),
        destinationPath,
        totalBytes: requestPayload.totalBytes,
        bytesDownloaded: 0,
        speedBytesPerSec: 0,
        status: 'downloading',
        networks,
        streams: [],
        peakStreams: 0,
        blocks,
        totalBlocks: blocks.length,
        blockSizeBytes,
        startedAt: Date.now(),
        ...(requestPayload.browser && {
          fromBrowser: requestPayload.browser.name ?? 'your browser'
        })
      }
      runtime = this.newHttpRuntime(
        state,
        requestPayload,
        new DownloadFile(`${destinationPath}.sonic`),
        blocks
      )
    }
    // Decided only now: other starts may have taken the room while this one was set up.
    const room = this.runningCount() < this.downloadsAtOnce && this.scheduleAllowsDownloads()
    if (!room) this.enqueue(runtime, false)
    runtime.state.scheduled = this.downloadSchedule?.enabled || undefined
    this.runtimes.set(id, runtime)
    await this.persistNow(runtime)
    this.pushUpdate(runtime)
    if (room) this.begin(runtime)

    return id
  }

  /** Runs the download, and once the run ends makes room for the next one queued. */
  private launch(runtime: DownloadRuntime): void {
    runtime.runPromise = this.run(runtime).finally(() => this.pump())
  }

  async pause(id: string, forSchedule = false): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (runtime?.state.status === 'queued') {
      if (forSchedule) {
        await runtime.runPromise
        return
      }
      runtime.state.scheduled = undefined
      runtime.state.status = 'paused'
      runtime.state.queuedAt = undefined
      runtime.state.pausedAt ??= Date.now()
      this.pushUpdate(runtime)
      await runtime.runPromise
      await this.persistNow(runtime)
      return
    }
    if (!runtime || runtime.state.status !== 'downloading' || runtime.publishing) return

    if (forSchedule) {
      runtime.scheduleStopping = true
      this.enqueue(runtime, false)
    } else {
      runtime.state.status = 'paused'
      runtime.state.scheduled = undefined
    }
    runtime.state.pausedAt = Date.now()
    clearSpeeds(runtime.state)
    if (runtime.kind === 'http') {
      for (const stream of runtime.state.streams) {
        if (stream.status !== 'completed') {
          stream.status = 'paused'
        }
        stream.currentBlockIndex = undefined
        stream.hedge = undefined
      }
    }
    for (const unit of unitsOf(runtime)) {
      if (unit.status === 'downloading') {
        unit.status = 'pending'
      }
      if (unit.kind === 'torrent') unit.provisionalBytes = 0
    }
    runtime.transfer.reset()
    this.stopRun(runtime)
    this.pushUpdate(runtime)
    try {
      await runtime.runPromise
      await this.persistNow(runtime)
    } finally {
      runtime.scheduleStopping = false
      this.pump()
    }
  }

  /** Gives a download whose link stopped working (a signed link ran out, say) a fresh link to the
   * same file, and resumes it from where it stopped. `given`: a link already checked, with the
   * browser sign-in it came with. */
  async relink(
    id: string,
    url: string,
    given?: { probe?: HttpProbeResult; browser?: BrowserContext }
  ): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (runtime?.kind !== 'http') throw new Error('Only web downloads support replacing a link.')
    const replaceable = (): boolean => {
      const { status, resumable } = runtime.state
      return (
        this.runtimes.get(id) === runtime &&
        resumable !== false &&
        (status === 'error' || status === 'paused')
      )
    }
    if (runtime.state.resumable === false) {
      throw new Error('This download can’t resume. Start it again.')
    }
    if (!replaceable()) throw new Error('Pause the download before replacing its link.')
    if (this.relinking.has(id)) throw new Error('A new link for this download is being checked.')
    this.relinking.add(id)
    try {
      await this.replaceLink(runtime, url, replaceable, given)
    } finally {
      this.relinking.delete(id)
    }
  }

  private async replaceLink(
    runtime: HttpDownloadRuntime,
    url: string,
    replaceable: () => boolean,
    given?: { probe?: HttpProbeResult; browser?: BrowserContext }
  ): Promise<void> {
    // A fresh link from the same site usually needs the same sign-in, so the old one carries over
    // unless the browser sent a new one.
    const browser = given?.browser ?? runtime.requestPayload.browser
    const probe = given?.probe ?? (await probeUrl(url, browser))
    if (probe.kind !== 'http') throw new Error('That isn’t a link to a file')
    const { totalBytes } = runtime.state
    if ((probe.totalBytes ?? 0) !== totalBytes) {
      throw new Error(
        `That link is to a different file: ${formatGigabytes(probe.totalBytes ?? 0)}, not ${formatGigabytes(totalBytes)}`
      )
    }
    if (splittable(runtime.requestPayload) && !probe.supportsRanges) {
      throw new Error(
        'This server doesn’t support resuming downloads. Try another link to the same file.'
      )
    }
    // An ETag or date from another link proves nothing about its bytes: two different files can
    // share them. Once resumed, only a label this download hasn't seen would make it compare
    // bytes, so they're compared now, before anything from the new link is written.
    const verdict = await this.compareWithDisk(runtime, probe.finalUrl, browser)
    if (verdict === 'different') {
      throw new Error('That link is to a different file: its bytes don’t match what’s downloaded.')
    }
    if (verdict === 'unknown') {
      throw new Error('Sonic couldn’t check that link against what’s downloaded. Try again.')
    }
    if (!replaceable()) throw new Error('The download changed while its new link was checked.')
    runtime.requestPayload.url = probe.finalUrl
    runtime.requestPayload.browser = browser
    runtime.state.url = probe.finalUrl
    await this.persistNow(runtime)
    this.resume(runtime.state.id)
  }

  private async compareWithDisk(
    runtime: HttpDownloadRuntime,
    url: string,
    browser: BrowserContext | undefined
  ): Promise<'same' | 'different' | 'unknown'> {
    // Nothing downloaded, nothing a different file could spoil.
    if (!runtime.blocks.some((block) => block.bytesDownloaded > 0)) return 'same'
    const available = await this.networks.refresh()
    const enabled = (iface: NetworkInterfaceInfo): boolean =>
      runtime.state.networks.some((network) => network.id === iface.id && network.enabled)
    const network = available.find(enabled) ?? available[0]
    if (!network) return 'unknown'
    const connection = new StreamConnection(() => network, {
      timeoutMs: testKnobs.stallTimeoutMs,
      connectTimeoutMs: testKnobs.connectTimeoutMs
    })
    try {
      return await compareSamples(runtime, url, browser, connection)
    } finally {
      connection.close()
    }
  }

  /** A failed download this link looks like the same file as: same name, size and strong ETag.
   * Only a suggestion for the user, who decides; relink then compares the bytes. */
  failedMatch(probe: HttpProbeResult): { id: string; fileName: string } | undefined {
    const strong = (etag: string | null): etag is string => etag !== null && !/^W\//i.test(etag)
    if (!strong(probe.etag) || !probe.totalBytes) return undefined
    const etag = normalizeEtag(probe.etag)
    for (const runtime of this.runtimes.values()) {
      if (runtime.kind !== 'http' || runtime.state.status !== 'error') continue
      const { requestPayload: request, state } = runtime
      if (
        state.resumable !== false &&
        state.totalBytes === probe.totalBytes &&
        request.suggestedFileName === probe.suggestedFileName &&
        strong(request.etag) &&
        normalizeEtag(request.etag) === etag
      ) {
        return { id: state.id, fileName: state.fileName }
      }
    }
    return undefined
  }

  resume(id: string): void {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.cancelPromise) return
    const { status, resumable } = runtime.state
    if (status !== 'paused' && !(status === 'error' && resumable !== false)) return

    void this.resumeAfterVerifying(runtime, false)
  }

  // A file that changed on the server while this download was paused is caught by the first
  // chunk request after resuming: its response is checked against the version the download
  // started on (see runWorker), which can tell a real change from a relabelled server. Whether a
  // network is there to resume on is the run's business: with none, it waits for one.
  // `byNetwork`: resumed by switching a network back on, rather than by Resume.
  private async resumeAfterVerifying(runtime: DownloadRuntime, byNetwork: boolean): Promise<void> {
    // The paused run can still be winding down: a writer closing, a sample check in flight. A new
    // one must not start beside it — both would go on to publish, and act on each other's streams.
    await runtime.runPromise
    // Just after launch the networks may not have been looked at yet.
    await this.networks.refresh()

    if ((await runtime.file.size().catch(() => -1)) < 0) {
      if (runtime.kind === 'http') {
        // A deleted staging file cannot support saved block progress. Recreate sparse storage and
        // restart safely from zero instead of leaving the task permanently unresumable.
        try {
          await runtime.file.recreate(runtime.state.totalBytes)
          for (const block of runtime.blocks) {
            block.status = 'pending'
            block.bytesDownloaded = 0
            block.bytesByInterface = {}
            block.interfaceId = undefined
          }
          for (const stream of runtime.state.streams) {
            stream.status = 'pending'
            stream.currentBlockIndex = undefined
            stream.hedge = undefined
            stream.bytesDownloaded = 0
            stream.speedBytesPerSec = 0
          }
          runtime.state.bytesDownloaded = 0
          runtime.state.speedBytesPerSec = 0
          runtime.state.peakSpeedBytesPerSec = undefined
          runtime.state.speedHistory = {}
          runtime.state.timeLeftSeconds = undefined
          runtime.state.error = undefined
          runtime.state.resumable = undefined
          runtime.transfer.reset()
          for (const network of runtime.state.networks) {
            network.bytesDownloaded = 0
            network.speedBytesPerSec = 0
            network.retries = 0
          }
          await this.persistNow(runtime, true)
        } catch (error) {
          runtime.state.error = `The partial download file is missing and could not be recreated: ${describeError(error)}`
          this.pushUpdate(runtime)
          return
        }
      } else {
        runtime.state.error =
          'The torrent destination is missing. Reconnect its drive or restore the torrent files, then retry.'
        this.pushUpdate(runtime)
        return
      }
    }
    if (
      runtime.cancelPromise ||
      (runtime.state.status !== 'paused' && runtime.state.status !== 'error')
    )
      return
    const { networks } = runtime.state
    // Switched back on, then off again while the paused run wound down: it stays paused.
    if (byNetwork && !networks.some((network) => network.enabled)) return

    if (this.runningCount() >= this.downloadsAtOnce || !this.scheduleAllowsDownloads()) {
      // Asked for by name, so it goes next.
      this.enqueue(runtime, true)
      runtime.state.error = undefined
      runtime.state.resumable = undefined
      runtime.pausedForNoNetwork = undefined
      this.pushUpdate(runtime)
      await this.persistNow(runtime)
      return
    }
    this.begin(runtime)
  }

  /** Starts a run of a paused, failed or queued download, from where it stopped. */
  private begin(runtime: DownloadRuntime): void {
    if (this.suspending || !this.scheduleAllowsDownloads()) {
      this.enqueue(runtime, false)
      this.pushUpdate(runtime)
      void this.persistNow(runtime)
      return
    }
    runtime.state.scheduled = this.downloadSchedule?.enabled || undefined
    const { networks } = runtime.state
    runtime.state.status = 'downloading'
    runtime.state.queuedAt = undefined
    runtime.state.error = undefined
    runtime.state.resumable = undefined
    runtime.pausedForNoNetwork = undefined
    // Paused by switching off every network: resuming switches back on the one switched off
    // last if it is still there, or else the first one present.
    if (!networks.some((network) => network.enabled)) {
      const present = (network: { id: string }): boolean => !!this.networks.find(network.id)
      const again =
        networks.find((network) => network.id === runtime.lastSwitchedOff && present(network)) ??
        networks.find(present) ??
        networks.find((network) => network.id === runtime.lastSwitchedOff) ??
        networks[0]
      if (again) again.enabled = true
    }
    // A network that had failed, or couldn't get through, gets another go.
    for (const network of runtime.state.networks) {
      if (network.status === 'failed' || network.status === 'unreachable') {
        network.status = 'on'
        network.error = undefined
      }
    }
    if (runtime.state.pausedAt) {
      runtime.state.totalPausedMs =
        (runtime.state.totalPausedMs || 0) + (Date.now() - runtime.state.pausedAt)
      runtime.state.pausedAt = undefined
    }
    for (const unit of unitsOf(runtime)) {
      if (unit.status === 'downloading') {
        unit.status = 'pending'
      }
      if (unit.kind === 'torrent') unit.provisionalBytes = 0
    }
    if (runtime.kind === 'http') {
      for (const stream of runtime.state.streams) {
        if (stream.status !== 'completed') {
          stream.status = 'pending'
          stream.currentBlockIndex = undefined
          stream.hedge = undefined
        }
        stream.speedBytesPerSec = 0
      }
    } else {
      runtime.state.peers.length = 0
    }
    runtime.transfer.reset()
    this.pushUpdate(runtime)

    this.launch(runtime)
  }

  /** Applies a receive cap to one download; null removes its cap. The state is part of the
   * manifest, so the choice survives pause/resume and application restarts. */
  async setDownloadSpeedLimit(id: string, bytesPerSecond: number | null): Promise<void> {
    await this.initialization
    if (
      bytesPerSecond !== null &&
      (!Number.isSafeInteger(bytesPerSecond) ||
        bytesPerSecond < 1 ||
        bytesPerSecond > 10 * 1024 ** 3)
    ) {
      throw new Error('Download speed limit must be a positive integer no greater than 10 GiB/s.')
    }
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new Error('This download is no longer active in Sonic.')
    if (bytesPerSecond === null) delete runtime.state.maxDownloadSpeedBytesPerSecond
    else runtime.state.maxDownloadSpeedBytesPerSecond = bytesPerSecond
    await this.persistNow(runtime, true)
    this.pushUpdate(runtime)
  }

  /** Sets persistent queue priority; higher-priority queued work starts first, FIFO within a level. */
  async setDownloadPriority(id: string, priority: 0 | 1 | 2): Promise<void> {
    await this.initialization
    if (priority !== 0 && priority !== 1 && priority !== 2) {
      throw new Error('Choose low, normal, or high download priority.')
    }
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new Error('This download is no longer active in Sonic.')
    if (runtime.state.status === 'completed' || runtime.state.status === 'cancelled') {
      throw new Error('Priority can only be changed for unfinished downloads.')
    }
    runtime.state.priority = priority
    await this.persistNow(runtime, true)
    this.pushUpdate(runtime)
    this.pump()
  }

  /** Applies an upload cap to one torrent task; null removes it. The persisted state survives
   * pause/resume and application restarts, and TorrentTransfer applies it to its dedicated client. */
  async setUploadSpeedLimit(id: string, bytesPerSecond: number | null): Promise<void> {
    await this.initialization
    if (
      bytesPerSecond !== null &&
      (!Number.isSafeInteger(bytesPerSecond) ||
        bytesPerSecond < 1 ||
        bytesPerSecond > 10 * 1024 ** 3)
    ) {
      throw new Error('Upload speed limit must be a positive integer no greater than 10 GiB/s.')
    }
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new Error('This download is no longer active in Sonic.')
    if (runtime.kind !== 'torrent')
      throw new Error('Per-download upload limits are only available for torrents.')
    if (bytesPerSecond === null) delete runtime.state.maxUploadSpeedBytesPerSecond
    else runtime.state.maxUploadSpeedBytesPerSecond = bytesPerSecond
    runtime.transfer.setUploadSpeedLimit(bytesPerSecond)
    await this.persistNow(runtime, true)
    this.pushUpdate(runtime)
  }

  /** Stop sharing a torrent once uploaded/downloaded bytes reaches the chosen ratio. */
  async setUploadRatioLimit(id: string, ratio: number | null): Promise<void> {
    await this.initialization
    if (
      ratio !== null &&
      (!Number.isFinite(ratio) || ratio < 0 || ratio > 10 || (ratio > 0 && ratio < 0.1))
    ) {
      throw new Error(
        'Upload ratio limit must be 0 (manual stop), between 0.1 and 10, or unset to disable post-completion seeding.'
      )
    }
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new Error('This download is no longer active in Sonic.')
    if (runtime.kind !== 'torrent')
      throw new Error('Upload ratio limits are only available for torrents.')
    // Unlimited is not a safe post-completion policy: choosing it while seeding means stop now.
    if (ratio === null && runtime.state.seeding) {
      await this.stopSeeding(id)
      return
    }
    if (ratio === null) {
      delete runtime.state.uploadRatioLimit
      delete runtime.state.uploadRatioReached
    } else {
      runtime.state.uploadRatioLimit = ratio
    }
    if (!runtime.transfer.setUploadRatioLimit) {
      throw new Error('The installed torrent engine does not support upload ratio limits.')
    }
    runtime.transfer.setUploadRatioLimit(ratio)
    await this.persistNow(runtime, true)
    this.pushUpdate(runtime)
  }

  /** Stops a completed torrent's bounded seeding session and archives it in history. */
  async stopSeeding(id: string): Promise<void> {
    await this.initialization
    const runtime = this.runtimes.get(id)
    if (runtime?.kind !== 'torrent' || !runtime.state.seeding) {
      throw new Error('This torrent is not currently seeding after completion.')
    }
    runtime.state.seeding = false
    runtime.stop.abort()
    await runtime.runPromise
  }

  /** Refreshes peer discovery through the torrent's configured trackers. */
  async refreshTorrentTrackers(id: string): Promise<void> {
    await this.initialization
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new Error('This download is no longer active in Sonic.')
    if (runtime.kind !== 'torrent')
      throw new Error('Tracker refresh is only available for torrents.')
    if (runtime.state.status !== 'downloading' && !runtime.state.seeding)
      throw new Error('Resume the torrent before refreshing its trackers.')
    runtime.transfer.refreshTrackers()
  }

  /** Switches one of a download's networks on or off, running or paused. Switching off the last
   * network in use pauses the download; switching one back on then resumes it. */
  async setNetworkEnabled(id: string, networkId: string, enabled: boolean): Promise<void> {
    const runtime = this.runtimes.get(id)
    const status = runtime?.state.status
    if (
      !runtime ||
      runtime.cancelPromise ||
      (status !== 'downloading' && status !== 'paused' && status !== 'queued')
    ) {
      return
    }
    const { networks } = runtime.state
    const network = networks.find((entry) => entry.id === networkId)
    if (!network || network.enabled === enabled) return
    const wasLast = !enabled && !networks.some((other) => other !== network && other.enabled)
    // A download that can't be split runs over one network: switching one on switches it over.
    if (enabled && runtime.kind === 'http' && !splittable(runtime.requestPayload)) {
      for (const other of networks) other.enabled = false
    }
    network.enabled = enabled
    if (!enabled) runtime.lastSwitchedOff = network.id
    if (wasLast && status === 'downloading') {
      runtime.pausedForNoNetwork = true
      await this.pause(id)
      // Not paused after all (it was already publishing): nothing for a network to resume.
      if (runtime.state.status !== 'paused') runtime.pausedForNoNetwork = undefined
      return
    }
    this.reconcile(runtime)
    this.pushUpdate(runtime)
    // Switched back on while the pause is still winding down, it resumes once that is done.
    if (enabled && status === 'paused' && runtime.pausedForNoNetwork) {
      void this.resumeAfterVerifying(runtime, true)
    }
  }

  /** The computer's networks changed (see NetworkMonitor). A network whose addresses changed
   * gets its streams going again at once: what they were waiting out may be what changed. One
   * that lost an address also drops its sockets, which may be bound to it. Chrome does the same
   * when its IP address changes (ERR_NETWORK_CHANGED). */
  networksChanged(): void {
    const changed = new Set<string>()
    const moved = new Set<string>()
    const seen = new Map<string, string[]>()
    for (const iface of this.networks.current ?? []) {
      const addresses = iface.addresses.map((entry) => entry.address)
      const before = this.seenAddresses.get(iface.id)
      seen.set(iface.id, addresses)
      if (before?.length === addresses.length && before.every((a) => addresses.includes(a))) {
        continue
      }
      changed.add(iface.id)
      if (before?.some((address) => !addresses.includes(address))) moved.add(iface.id)
    }
    this.seenAddresses = seen

    for (const runtime of this.runtimes.values()) {
      const { status } = runtime.state
      if (status !== 'downloading' && status !== 'paused' && status !== 'queued') continue
      this.reconcile(runtime)
      runtime.transfer.wake(
        (id) => changed.has(id),
        (id) => moved.has(id)
      )
      this.scheduleUpdate(runtime)
    }
  }

  /** The computer woke from sleep. Its sockets are likely dead, though nothing will say so until
   * a stall watchdog runs out, and every judgement made by the clock (a silent network, a
   * crawling connection) spans the sleep. All of it starts over. */
  systemResumed(): void {
    void this.refreshSchedule().catch((error) =>
      console.error('[Sonic] schedule after wake', error)
    )
    const now = Date.now()
    for (const runtime of this.runtimes.values()) {
      if (runtime.state.status !== 'downloading') continue
      runtime.transfer.systemResumed(now)
    }
  }

  /** Keeps the computer from sleeping while a download runs, which would stop it — as
   * qBittorrent and Transmission offer to. The display can still sleep. */
  private keepAwake(): void {
    const running = [...this.runtimes.values()].some(
      (runtime) => runtime.state.status === 'downloading'
    )
    try {
      if (running && this.awakeBlocker === null) {
        this.awakeBlocker = powerSaveBlocker.start('prevent-app-suspension')
      } else if (!running && this.awakeBlocker !== null) {
        powerSaveBlocker.stop(this.awakeBlocker)
        this.awakeBlocker = null
      }
    } catch {
      // Not every desktop can be kept awake; the download runs regardless.
    }
  }

  /** A torrent download's own .torrent, read: its files never change, so they're read when
   * needed rather than kept or sent with every update. */
  private async torrentInfo(id: string): Promise<TorrentInfo | null> {
    const request = this.runtimes.get(id)?.requestPayload
    if (request?.kind !== 'torrent') return null
    const probe = await describeTorrent(await readFile(this.torrentFilePath(id)), request.url)
    return probe.kind === 'torrent' ? probe.torrent : null
  }

  /** A torrent download's files, each marked by whether it's chosen. */
  async torrentFiles(id: string): Promise<TorrentFileEntry[]> {
    const torrent = await this.torrentInfo(id)
    const request = this.runtimes.get(id)?.requestPayload
    if (!torrent || request?.kind !== 'torrent') return []
    const chosen = chosenFiles(request.selectedFiles, torrent.files.length)
    return torrent.files.map((file, index) => ({
      ...file,
      chosen: !chosen || chosen.has(index),
      priority: request.filePriorities?.[index] ?? 1
    }))
  }

  /** Opens a selected, supported media file through a short-lived loopback stream. */
  canPreviewHttpMedia(id: string): boolean {
    const runtime = this.runtimes.get(id)
    if (runtime?.kind !== 'http' || runtime.state.status !== 'downloading') return false
    if (runtime.requestPayload.mediaStream || runtime.state.bytesDownloaded <= 0) return false
    return /\.(mp4|webm|m4v|mov|mp3|m4a|aac|wav|ogg|oga|opus)$/i.test(runtime.state.fileName)
  }

  /** Opens a short-lived local progressive stream for a sequential HTTP media download. */
  async previewHttpMedia(id: string): Promise<void> {
    await this.initialization
    const url = await this.httpMediaPreview.open(id)
    await shell.openExternal(url)
  }

  async previewTorrentFile(id: string, fileIndex: number): Promise<void> {
    await this.initialization
    const runtime = this.runtimes.get(id)
    if (runtime?.kind !== 'torrent' || runtime.state.status !== 'downloading') {
      throw new Error('Preview is available while a torrent is actively downloading.')
    }
    const info = await this.torrentInfo(id)
    const file = info?.files[fileIndex]
    if (!file) throw new Error('That file is not part of this torrent.')
    const extension = file.path.slice(file.path.lastIndexOf('.')).toLowerCase()
    const supported = new Set([
      '.mp4',
      '.webm',
      '.m4v',
      '.mov',
      '.mp3',
      '.m4a',
      '.aac',
      '.wav',
      '.ogg',
      '.oga',
      '.opus'
    ])
    if (!supported.has(extension)) {
      throw new Error(
        'Preview supports MP4, WebM, M4V, MOV, MP3, M4A, AAC, WAV, OGG and Opus files.'
      )
    }
    const url = await this.torrentPreview.open(id, fileIndex)
    await shell.openExternal(url)
  }

  /** Set a numeric WebTorrent selection priority for one file; selection itself is unchanged. */
  async setTorrentFilePriority(id: string, fileIndex: number, priority: 0 | 1 | 2): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (runtime?.kind !== 'torrent') throw new Error('This download has no torrent files.')
    if (runtime.state.status === 'completed' || runtime.state.status === 'cancelled') {
      throw new Error('File priorities can only be changed for unfinished torrents.')
    }
    if (priority !== 0 && priority !== 1 && priority !== 2) {
      throw new Error('Choose low, normal, or high file priority.')
    }
    const torrent = await this.torrentInfo(id)
    if (
      !torrent ||
      !Number.isInteger(fileIndex) ||
      fileIndex < 0 ||
      fileIndex >= torrent.files.length
    ) {
      throw new Error('That file is not part of this torrent.')
    }
    const priorities = [...(runtime.requestPayload.filePriorities ?? [])]
    while (priorities.length < torrent.files.length) priorities.push(1)
    priorities[fileIndex] = priority
    runtime.requestPayload.filePriorities = priorities
    runtime.state.filePriorities = priorities
    runtime.transfer.filesChosen()
    await this.persistNow(runtime, true)
    this.pushUpdate(runtime)
  }

  /** Replace additional announce URLs. Changing them on an active run restarts only this task's
   * WebTorrent client so the engine can initialize discovery with the updated announce list. */
  async setTorrentTrackers(id: string, input: string[]): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (runtime?.kind !== 'torrent') throw new Error('This download is not a torrent.')
    if (runtime.state.status === 'completed' || runtime.state.status === 'cancelled') {
      throw new Error('Trackers can only be changed for unfinished torrents.')
    }
    if (!Array.isArray(input) || input.length > 20) {
      throw new Error('Add at most 20 custom trackers.')
    }
    const trackers: string[] = []
    for (const raw of input) {
      if (typeof raw !== 'string' || raw.trim().length > 2048) {
        throw new Error('Each tracker must be a valid URL up to 2048 characters.')
      }
      const value = raw.trim()
      if (!value) continue
      let url: URL
      try {
        url = new URL(value)
      } catch {
        throw new Error(`Invalid tracker URL: ${value}`)
      }
      if (
        !['http:', 'https:', 'udp:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.hash
      ) {
        throw new Error(
          `Tracker must use HTTP, HTTPS, or UDP without credentials or a fragment: ${value}`
        )
      }
      const normalized = url.toString()
      if (!trackers.includes(normalized)) trackers.push(normalized)
    }
    if (trackers.length > 20) throw new Error('Add at most 20 custom trackers.')
    const wasDownloading = runtime.state.status === 'downloading'
    if (wasDownloading) {
      await this.pause(id)
      await runtime.runPromise
    }
    if (this.runtimes.get(id) !== runtime || runtime.cancelPromise) {
      throw new Error('This torrent changed while its trackers were being updated.')
    }
    if (trackers.length) {
      runtime.requestPayload.customTrackers = trackers
      runtime.state.customTrackers = trackers
    } else {
      delete runtime.requestPayload.customTrackers
      delete runtime.state.customTrackers
    }
    await this.persistNow(runtime, true)
    this.pushUpdate(runtime)
    if (wasDownloading) this.resume(id)
  }

  /** Changes which of a torrent download's files it fetches, running or not, as its choice
   * (requestPayload.selectedFiles) everything else follows from. What's in stays in: the pieces
   * a newly chosen file needs are fetched, those no chosen file needs any more aren't. A file
   * that's in can't be dropped: it's done, and dropping it would delete it once the download is. */
  async chooseTorrentFiles(id: string, selected: number[]): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (runtime?.kind !== 'torrent') throw new Error('This download has no files to choose')
    // Ticks come quicker than the disk answers: one overtaken by a later one gives way to it.
    const turn = ++runtime.fileChoices
    const torrent = await this.torrentInfo(id)
    if (!torrent) throw new Error('This download has no files to choose')
    // Done or going: its files are what they are. Checked again after waiting on the disk.
    const settled = (): boolean =>
      runtime.publishing ||
      runtime.state.status === 'completed' ||
      runtime.state.status === 'cancelled' ||
      this.runtimes.get(id) !== runtime
    if (settled()) throw new Error('This download’s files can’t change now')

    const chosen = chosenFiles(selected, torrent.files.length)
    const completed = runtime.pieces.map((piece) => piece.status === 'completed')
    const finished = finishedFiles(torrent.files, torrent.pieceLength, completed)
    if (chosen && [...finished].some((index) => !chosen.has(index))) {
      throw new Error('A file that’s already downloaded stays')
    }
    const wanted = chosen && wantedPieces(torrent.files, torrent.pieceLength, chosen)
    let adding = 0
    for (const piece of runtime.pieces) {
      if (piece.status === 'skipped' && (!wanted || wanted[piece.index])) {
        adding += piece.rangeEnd! - piece.rangeStart + 1
      }
    }
    await ensureDiskSpace(runtime.requestPayload.destinationDir, adding)
    if (settled()) throw new Error('This download’s files can’t change now')
    if (turn !== runtime.fileChoices) return

    runtime.state.files = choiceOf(chosen, torrent.files.length)
    runtime.requestPayload.selectedFiles = runtime.state.files.selected
    runtime.state.skippedBytes = choosePieces(runtime.pieces, torrent, chosen)
    runtime.file.unwanted = unchosenPaths(torrent, chosen)
    runtime.transfer.filesChosen()
    // Sent now, ahead of the answer: the window shows the choice from the state it's sent.
    this.pushUpdate(runtime)
  }

  async cancel(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (runtime?.cancelPromise) return runtime.cancelPromise
    if (
      !runtime ||
      runtime.publishing ||
      (runtime.state.status !== 'downloading' &&
        runtime.state.status !== 'paused' &&
        runtime.state.status !== 'queued' &&
        runtime.state.status !== 'error')
    )
      return

    runtime.cancelPromise = this.cancelRuntime(runtime)
    try {
      await runtime.cancelPromise
    } finally {
      runtime.cancelPromise = undefined
    }
  }

  private async cancelRuntime(runtime: DownloadRuntime): Promise<void> {
    try {
      // Stop writing first, but keep the item visible until its files and manifest are gone.
      await this.pause(runtime.state.id)
      if (runtime.state.status !== 'error') {
        runtime.state.status = 'paused'
        runtime.state.queuedAt = undefined
        runtime.state.pausedAt ??= Date.now()
      }
      clearSpeeds(runtime.state)
      this.stopRun(runtime)
      this.pushUpdate(runtime, false)
      await runtime.runPromise?.catch(() => {})
      await runtime.file.discard()
      await this.removePersistedDownload(runtime, false)
      runtime.state.status = 'cancelled'
      if (runtime.kind === 'http') {
        for (const stream of runtime.state.streams) stream.status = 'cancelled'
      }
      this.pushUpdate(runtime, false)
    } catch (error) {
      runtime.removed = false
      runtime.state.status = 'error'
      runtime.state.error = error instanceof Error ? error.message : String(error)
      // Cleanup may have removed only some files: retry cancellation rather than resuming them.
      runtime.state.resumable = false
      this.pushUpdate(runtime, false)
      await this.persistNow(runtime)
      throw error
    } finally {
      // A queued one never ran, so no run's end makes room after it.
      this.pump()
    }
  }

  /** Removes a download, cancelling one under way. A finished one's file stays where it is,
   * unless `trashFile`: then it goes to the Trash, where the user can still get it back. The
   * path is the download's own, never one the window names. */
  async remove(id: string, trashFile = false): Promise<void> {
    await this.initialization
    let runtime = this.runtimes.get(id)
    if (runtime?.state.status === 'completed') {
      // Completion is shown before history is saved. Let that move finish before choosing
      // whether to remove a live runtime or a history entry, including for torrent file removal.
      await runtime.runPromise?.catch(() => {})
      runtime = this.runtimes.get(id)
    }
    if (
      runtime &&
      (runtime.state.status === 'downloading' ||
        runtime.state.status === 'paused' ||
        runtime.state.status === 'queued' ||
        runtime.state.status === 'error')
    ) {
      await this.cancel(id)
    }
    if (runtime) {
      if (trashFile && runtime.state.status === 'completed') {
        const owned =
          runtime.kind === 'torrent'
            ? (await this.torrentFiles(id))
                .filter((file) => file.chosen)
                .map((file) => file.path.split(/[\\/]/).slice(1).join(sep))
            : undefined
        await trashDownload(runtime.state, owned)
      }
      this.limits.forgetTask(id)
      this.runtimes.delete(id)
      await this.removePersistedDownload(runtime)
      if (runtime.state.status === 'completed') {
        // Keep the durable history entry but hide it from the main list.
        await markHistoryRemoved(id)
        this.historyChanged()
      }
      return
    }
    // A finished one, from history. Removal never erases the audit/history record.
    const entry = await findInHistory(id)
    if (trashFile && entry && !entry.missing) await trashDownload(entry)
    if (entry) await markHistoryRemoved(id)
    this.historyChanged()
  }

  /** Shows a download's file in its folder (while it's downloading, its `.sonic` staging file):
   * by the download's own path, never one the window
   * names, and only once it's checked to be there — the window's view of that can be old (the
   * file moved or deleted since). When it isn't, the window is told to look again, and the
   * history it gets marks it missing. */
  async reveal(id: string): Promise<boolean> {
    const runtime = this.runtimes.get(id)
    const download = runtime?.state ?? (await findInHistory(id))
    // Until it's published, what's on disk is its staging file (an HTTP download's
    // `<name>.sonic`), not the path it will end up at.
    const unfinished = runtime && runtime.state.status !== 'completed'
    for (const path of [unfinished ? runtime.file.path : undefined, download?.destinationPath]) {
      if (path && (await pathExists(path).catch(() => false))) {
        shell.showItemInFolder(path)
        return true
      }
    }
    this.historyChanged()
    return false
  }

  /** Opens a finished download with the app the OS picks for it; a torrent's folder opens in the
   * file manager. Like reveal, it checks the path first and false means it's no longer there. */
  async open(id: string): Promise<boolean> {
    const download = this.runtimes.get(id)?.state ?? (await findInHistory(id))
    const path = download?.destinationPath
    if (path && (await pathExists(path).catch(() => false))) {
      return (await shell.openPath(path)) === ''
    }
    this.historyChanged()
    return false
  }

  async suspendAll(): Promise<void> {
    await this.initialization
    this.suspending = true
    clearTimeout(this.scheduleTimer)
    await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        if (runtime.state.status === 'downloading') {
          await this.pause(runtime.state.id, runtime.state.scheduled === true)
        } else if (runtime.kind === 'torrent' && runtime.state.seeding) {
          runtime.state.seeding = false
          runtime.stop.abort()
          await runtime.runPromise
        } else {
          if (runtime.scheduleStopping) await runtime.runPromise
          await this.persistNow(runtime)
        }
      })
    )
    await this.limits.save()
  }

  /**
   * Runs the download until every block is in, or it is stopped. Each TICK_MS, and whenever a
   * stream ends, it takes stock: speeds, stuck connections, which networks run streams (see
   * reconcile) and how many (see concurrency.ts). With no network to use, it waits for one.
   */
  private async run(runtime: DownloadRuntime): Promise<void> {
    if (runtime.stop.signal.aborted) runtime.stop = new AbortController()
    runtime.transfer.reset()
    // Speeds are this run's: nothing carries over from the last one.
    runtime.meters.clear()
    if (runtime.kind === 'torrent') runtime.uploadMeters.clear()
    const { signal } = runtime.stop
    this.reconcile(runtime)
    // One watcher per stream for its whole life. Racing every stream each tick would pile a
    // handler per tick onto each one still running, held until it ends.
    const watched = new WeakSet<Promise<void>>()
    let wake: { resolve: () => void; reject: (error: unknown) => void } | null = null
    let tickedAt = Date.now()
    // Readings carry over a pause, moved up to now: time paused isn't time downloading, so a
    // stretch can run across one, and runs too short for a stretch of their own still count — as
    // they do in AVG, which a reset here let read above PEAK.
    const lastReading = runtime.peakReadings.at(-1)
    const paused = lastReading ? tickedAt - lastReading.time : 0
    runtime.peakReadings = runtime.peakReadings.map((reading) => ({
      time: reading.time + paused,
      bytes: reading.bytes
    }))
    if (runtime.peakReadings.at(-1)?.bytes !== runtime.state.bytesDownloaded) {
      runtime.peakReadings.push({ time: tickedAt, bytes: runtime.state.bytesDownloaded })
    }

    while (
      runtime.state.status === 'downloading' &&
      unitsOf(runtime).some((unit) => !isDone(unit))
    ) {
      await new Promise<void>((resolve, reject) => {
        wake = { resolve, reject }
        for (const worker of runtime.transfer.running()) {
          if (watched.has(worker)) continue
          watched.add(worker)
          worker.then(
            () => wake?.resolve(),
            (error) => wake?.reject(error)
          )
        }
        void delay(TICK_MS, signal).then(resolve)
      })
      if ((runtime.state.status as DownloadStatus) !== 'downloading') break
      const now = Date.now()
      // The only place speeds are read: on this clock, never as bytes arrive (see Meter).
      const speedsChanged = updateSpeeds(runtime, now)
      const timeLeftChanged = updateTimeLeft(runtime.state, (now - tickedAt) / 1000)
      tickedAt = now
      if (speedsChanged || timeLeftChanged) this.scheduleUpdate(runtime)
      if (now - runtime.speedSampledAt >= 1000) {
        runtime.speedSampledAt = now
        sampleSpeeds(runtime.state)
        samplePeak(runtime, now)
        this.scheduleUpdate(runtime)
      }
      runtime.transfer.tick(now)
    }
    // The last blocks are in, or the run was stopped: its streams wind down. Its last part reads
    // too, up to the moment it stopped (and where the next run picks up).
    samplePeak(runtime, Date.now())
    // A configured ratio is the explicit, finite seeding policy: once the payload is complete,
    // keep this torrent's dedicated client alive until the ratio is reached or the user stops it.
    const seedAfterComplete =
      runtime.state.status === 'downloading' &&
      runtime.kind === 'torrent' &&
      unitsOf(runtime).every(isDone) &&
      runtime.state.uploadRatioLimit !== undefined &&
      !runtime.state.uploadRatioReached
    if (!seedAfterComplete) {
      runtime.stop.abort()
      await Promise.all(runtime.transfer.running())
    }
    // However it ended — paused, failed, cancelled, done — nothing is moving now. A seeding
    // client remains alive, and its upload meter will be refreshed by the seeding loop below.
    clearSpeeds(runtime.state)

    if (runtime.state.status !== 'downloading') {
      // Paused, errored, or cancelled — nothing left to do right now. An error keeps what it has
      // unless it can't be resumed (see failDownload); cancel() discards it.
      if (runtime.state.status === 'error') {
        this.pushUpdate(runtime)
        if (runtime.state.resumable === false) await runtime.file.discard()
        // Terminal failures must replace the last paused/downloading checkpoint. Otherwise a
        // restart can silently restore stale status and lose the error/retry decision.
        await this.persistNow(runtime)
      }
      return
    }

    runtime.publishing = true
    try {
      if (unitsOf(runtime).some((unit) => !isDone(unit))) {
        throw new Error('Download is incomplete — refusing to publish the file')
      }
      if (runtime.kind === 'http' && runtime.requestPayload.expectedSha256) {
        const actual = await hashCompletedOutput(runtime.file.path)
        if (actual.sha256.toLowerCase() !== runtime.requestPayload.expectedSha256.toLowerCase()) {
          runtime.state.resumable = false
          throw new Error(
            'Metalink SHA-256 verification failed. The downloaded file does not match the publisher checksum; it will not be published.'
          )
        }
      }
      await this.persistNow(runtime)
      const publishedPath = await runtime.file.publish(
        runtime.state.destinationPath,
        runtime.state.totalBytes,
        async (candidate) => {
          runtime.publicationPath = candidate
          const partial = await stat(runtime.file.path)
          runtime.publicationIdentity = { dev: partial.dev, ino: partial.ino }
          await this.persistNow(runtime, true)
        }
      )
      runtime.state.destinationPath = publishedPath
      runtime.state.fileName = basename(publishedPath)
      runtime.state.status = 'completed'
      runtime.state.completedAt = Date.now()
      if (runtime.kind === 'torrent') {
        runtime.state.seeding = seedAfterComplete && !runtime.state.uploadRatioReached
      }
      // Done before it downloaded for PEAK_SECONDS: its speed start to finish, pauses left out (the
      // readings close them up), is the best it held.
      const [start] = runtime.peakReadings
      const end = runtime.peakReadings.at(-1)
      const ranFor = start && end ? (end.time - start.time) / 1000 : 0
      if (ranFor > 0) {
        runtime.state.peakSpeedBytesPerSec ??= (end!.bytes - start.bytes) / ranFor
      }
      runtime.state.bytesDownloaded =
        runtime.state.totalBytes -
          (runtime.state.kind === 'torrent' ? runtime.state.skippedBytes : 0) ||
        runtime.state.bytesDownloaded
      await this.persistNow(runtime)
      await runtime.file.discardLeftover().catch(() => {})
      this.performCompletionAction(
        runtime.state.destinationPath,
        runtime.state.fileName,
        runtime.state.bytesDownloaded,
        runtime.state.id
      )
    } catch (error) {
      runtime.state.status = 'error'
      runtime.state.error = error instanceof Error ? error.message : String(error)
      // Keep the failure and publication intent on disk: after restart recovery can finish or
      // retry publication instead of silently restoring the previous checkpoint.
      await this.persistNow(runtime).catch((persistError: unknown) => {
        console.error('[Sonic] could not persist publication failure', persistError)
      })
      this.notify(
        'Download failed',
        `${runtime.state.fileName}: ${describeError(runtime.state.error)}`
      )
    }
    runtime.publishing = false

    this.pushUpdate(runtime)
    if (
      runtime.state.status === 'completed' &&
      runtime.kind === 'torrent' &&
      runtime.state.seeding
    ) {
      // Ratio enforcement happens on each upload event. The loop only keeps telemetry fresh and
      // provides a stop point for the user's Stop seeding action or application shutdown.
      while (
        runtime.state.seeding &&
        !runtime.stop.signal.aborted &&
        !runtime.state.uploadRatioReached
      ) {
        await delay(TICK_MS, runtime.stop.signal)
        updateSpeeds(runtime, Date.now())
        this.pushUpdate(runtime)
      }
      runtime.state.seeding = false
      runtime.stop.abort()
      await Promise.all(runtime.transfer.running())
      clearSpeeds(runtime.state)
      this.pushUpdate(runtime)
      await this.persistNow(runtime).catch((error: unknown) => {
        console.error('[Sonic] could not persist final seeding state', error)
      })
    } else if (seedAfterComplete) {
      // The ratio may have been reached during publication, before the seeding loop starts.
      runtime.stop.abort()
      await Promise.all(runtime.transfer.running())
      clearSpeeds(runtime.state)
    }
    if (runtime.state.status === 'completed') await this.moveToHistory(runtime)
  }

  /** Stops the current run: every stream, and the run's own wait. */
  private stopRun(runtime: DownloadRuntime): void {
    runtime.stop.abort()
    runtime.transfer.abort()
  }

  /** Ends the download in an error. What it has downloaded stays for a resume, unless
   * `discard`: bytes that are no use any more. */
  private failDownload(runtime: DownloadRuntime, message: string, discard = false): void {
    if (runtime.state.status !== 'downloading') return
    runtime.state.status = 'error'
    runtime.state.error = message
    runtime.state.resumable = !discard
    this.notify('Download failed', `${runtime.state.fileName}: ${describeError(message)}`)
    this.stopRun(runtime)
  }

  /** The server keeps refusing requests over this network: it stops being used until the user
   * switches it off and on, it reconnects, or the download is resumed. */
  private failNetwork(runtime: DownloadRuntime, network: DownloadNetwork, message: string): void {
    network.status = 'failed'
    network.error = message
    this.reconcile(runtime)
  }

  /**
   * Brings the download's networks up to date with the computer's, and each network's streams in
   * line with what it can do now. Runs every tick and whenever something changes — a network
   * came or went, the user switched one, one stopped getting through — and is safe to run any
   * time.
   *
   * Networks: every one on the computer is listed; one that turns up mid-download starts off,
   * for the user to switch on. A network the download never used is dropped once it goes.
   *
   * Streams, while the download runs, are the transfer's (see HttpTransfer.reconcile).
   */
  private reconcile(runtime: DownloadRuntime): void {
    const { state } = runtime
    const present = this.networks.current
    // Until the monitor has looked, nothing is known to be gone.
    const known = present !== null
    if (known) {
      if (state.kind === 'http') {
        state.networks = state.networks.filter(
          (network) =>
            network.enabled ||
            network.bytesDownloaded > 0 ||
            present.some((iface) => iface.id === network.id) ||
            state.streams.some((stream) => stream.interfaceId === network.id)
        )
      } else {
        state.networks = state.networks.filter(
          (network) =>
            network.enabled ||
            network.bytesDownloaded > 0 ||
            network.bytesUploaded > 0 ||
            present.some((iface) => iface.id === network.id) ||
            state.peers.some((peer) => peer.interfaceId === network.id)
        )
      }
      for (const iface of present) {
        if (!state.networks.some((network) => network.id === iface.id)) {
          if (state.kind === 'http') state.networks.push(newHttpNetwork(iface, false))
          else state.networks.push(newTorrentNetwork(iface, false))
        }
      }
    }

    for (const network of state.networks) {
      const iface = this.networks.find(network.id)
      if (iface) {
        network.label = iface.displayName
        network.kind = iface.kind
      }
      const status: NetworkStatus = !network.enabled
        ? 'off'
        : !iface && known
          ? 'offline'
          : this.limits.limitReached(network.id)
            ? 'limit'
            : network.status === 'off' || network.status === 'offline' || network.status === 'limit'
              ? 'on'
              : network.status
      if (status !== network.status) {
        network.status = status
        network.error = undefined
      }
    }
    if (state.status !== 'downloading' || runtime.stop.signal.aborted) return
    if (!this.scheduleAllowsDownloads()) {
      void this.pause(state.id, true).catch((error) =>
        console.error('[Sonic] schedule cutoff', error)
      )
      return
    }

    const enabled = state.networks.filter((network) => network.enabled)
    if (enabled.length > 0 && enabled.every((network) => network.status === 'failed')) {
      this.failDownload(runtime, enabled[0].error ?? 'No network could reach the server')
      return
    }

    runtime.transfer.reconcile()
  }

  private performCompletionAction(
    path: string,
    fileName: string,
    sizeBytes: number,
    downloadId: string
  ): void {
    // Legacy "open" preferences now use the notification's explicit Open button rather than
    // executing downloaded code automatically. "none" is the persistent off switch.
    if (this.getCompletionAction() === 'none') return
    this.notify('Download complete', fileName, path, sizeBytes, downloadId)
  }

  private notify(
    title: string,
    body: string,
    completedPath?: string,
    sizeBytes?: number,
    dedupeKey?: string
  ): void {
    if (
      (testKnobs.userDataDir && process.env['SONIC_E2E_NOTIFICATIONS'] !== '1') ||
      this.getCompletionAction() === 'none'
    )
      return
    void loadSettings()
      .then((settings) => {
        // Capture the main window before the toast is created; getAllWindows()[0] may then
        // refer to the toast itself, which would close immediately after the click.
        const mainWindow = this.getWindow()
        return showCompletionToast({
          title,
          fileName: body,
          path: completedPath,
          sizeBytes,
          dedupeKey,
          themeSource: settings.themeSource ?? 'sonic',
          onOpenApp: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              if (mainWindow.isMinimized()) mainWindow.restore()
              mainWindow.show()
              mainWindow.focus()
            }
          }
        })
      })
      .catch((error: unknown) => {
        console.warn('[Sonic] could not show notification:', error)
      })
  }

  private scheduleUpdate(runtime: DownloadRuntime): void {
    if (runtime.pushScheduled) return
    runtime.pushScheduled = true
    setTimeout(() => {
      runtime.pushScheduled = false
      this.pushUpdate(runtime)
    }, UI_UPDATE_MS)
  }

  private pushUpdate(runtime: DownloadRuntime, persist = true): void {
    this.keepAwake()
    // A removed download can still be winding down (workers finishing, cleanup). Its updates
    // would put it back on screen after the renderer has already moved on.
    if (this.runtimes.get(runtime.state.id) !== runtime) return
    if (persist) this.schedulePersistence(runtime)
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    if (runtime.state.status === 'paused' || runtime.state.status === 'cancelled') {
      clearSpeeds(runtime.state)
    }
    window.webContents.send(IpcChannels.downloadUpdated, this.takeUpdate(runtime))
  }

  /** What the window hasn't been sent yet: the download's state, and the work units that moved. */
  private takeUpdate(runtime: DownloadRuntime): DownloadUpdate {
    if (runtime.kind === 'http') {
      const changed = this.changedUnits(runtime, runtime.blocks)
      const { blocks: omittedBlocks, ...state } = runtime.state
      void omittedBlocks
      return structuredClone({ seq: ++runtime.sentUpdates, state, blocks: changed })
    }
    const changed = this.changedUnits(runtime, runtime.pieces)
    const { pieces: omittedPieces, ...state } = runtime.state
    void omittedPieces
    return structuredClone({ seq: ++runtime.sentUpdates, state, pieces: changed })
  }

  private changedUnits<T extends DownloadUnitState>(runtime: DownloadRuntime, units: T[]): T[] {
    const sent = runtime.sentUnits
    const changed: T[] = []
    for (const unit of units) {
      const last = sent[unit.index]
      if (
        last?.status === unit.status &&
        last.interfaceId === unit.interfaceId &&
        last.bytesDownloaded === unit.bytesDownloaded &&
        last.provisionalBytes === (unit.kind === 'torrent' ? unit.provisionalBytes : undefined)
      ) {
        continue
      }
      sent[unit.index] = {
        status: unit.status,
        interfaceId: unit.interfaceId,
        bytesDownloaded: unit.bytesDownloaded,
        provisionalBytes: unit.kind === 'torrent' ? unit.provisionalBytes : undefined
      }
      changed.push(unit)
    }
    return changed
  }

  private schedulePersistence(runtime: DownloadRuntime): void {
    if (this.suspending || runtime.removed || runtime.persistenceTimer || runtime.checkpointQueued)
      return
    runtime.persistenceTimer = setTimeout(() => {
      runtime.persistenceTimer = undefined
      // One running and one waiting at most, however slow the disk: the waiting one takes the
      // state when its turn comes, so nothing scheduled meanwhile is lost.
      runtime.checkpointQueued = true
      void this.persistNow(runtime, false, true)
    }, CHECKPOINT_INTERVAL_MS)
  }

  private persistNow(
    runtime: DownloadRuntime,
    required = false,
    routineCheckpoint = false
  ): Promise<void> {
    if (runtime.removed) return runtime.persistenceChain
    if (runtime.persistenceTimer) {
      clearTimeout(runtime.persistenceTimer)
      runtime.persistenceTimer = undefined
    }

    const operation = runtime.persistenceChain
      .catch(() => {})
      .then(async () => {
        // An explicit save can run ahead of a queued routine checkpoint. Only that
        // checkpoint owns the flag; other saves must leave its place reserved.
        if (routineCheckpoint) runtime.checkpointQueued = false
        if (runtime.removed) return
        const dir = this.downloadDir(runtime.state.id)
        const path = this.manifestPath(runtime.state.id)
        const temporaryPath = `${path}.tmp`
        let state: PersistedState
        if (runtime.kind === 'http') {
          const { blocks: omittedBlocks, streams: omittedStreams, ...rest } = runtime.state
          void omittedBlocks
          void omittedStreams
          state = rest
        } else {
          const { pieces: omittedPieces, peers: omittedPeers, ...rest } = runtime.state
          void omittedPieces
          void omittedPeers
          state = rest
        }
        const persisted: PersistedDownload = {
          version: 7,
          savedAt: Date.now(),
          state: structuredClone(state),
          ...saveBlocks(unitsOf(runtime)),
          partialPath: runtime.file.path,
          publicationPath: runtime.publicationPath,
          publicationIdentity: runtime.publicationIdentity,
          ...savedRequest(runtime)
        }
        if (['downloading', 'paused', 'queued'].includes(runtime.state.status)) {
          await runtime.file.sync()
        }
        await ensureDirectory(dir)
        await writeFile(temporaryPath, JSON.stringify(persisted), 'utf-8')
        await rename(temporaryPath, path)
      })
    runtime.persistenceChain = operation.catch(() => {
      // Routine progress checkpoints are best-effort. Publication intent is required.
    })
    return required ? operation : runtime.persistenceChain
  }

  private async removePersistedDownload(
    runtime: DownloadRuntime,
    discardPartial = true
  ): Promise<void> {
    runtime.removed = true
    if (runtime.persistenceTimer) clearTimeout(runtime.persistenceTimer)
    await runtime.persistenceChain.catch(() => {})
    // A finished download is the user's now: only what's left of it goes.
    if (discardPartial) {
      const file = runtime.file
      await (runtime.state.status === 'completed' ? file.discardLeftover() : file.discard()).catch(
        () => {}
      )
    }
    await rm(this.downloadDir(runtime.state.id), { recursive: true, force: true })
  }
}
