export type NetworkInterfaceKind = 'wifi' | 'usb' | 'ethernet' | 'bridge' | 'other'
export type IpFamily = 4 | 6

export interface NetworkAddress {
  address: string
  family: IpFamily
  netmask?: string
  /** Used by the existing IPv4 same-subnet warning. */
  subnet?: string
}

export type ThemeSource = 'sonic' | 'light' | 'dark'

export type UpdateDownloadProgress = {
  bytesDownloaded: number
  totalBytes: number
  percent: number
  phase: 'downloading' | 'verifying' | 'starting-installer'
}

export type RemoteControlScope = 'status:read' | 'task:add' | 'task:control'
export interface RemoteControlState {
  enabled: boolean
  url: string | null
  interfaceId: string | null
  caFingerprint: string | null
  pairingExpiresAt: number | null
  auditEvents: { at: number; event: string; deviceId?: string }[]
  devices: {
    id: string
    label: string
    scopes: RemoteControlScope[]
    createdAt: number
    expiresAt: number
    revoked: boolean
  }[]
  wifiInterfaces: { id: string; displayName: string; addresses: string[] }[]
}

export interface NetworkInterfaceInfo {
  /** Stable identifier for this interface (currently the OS device name, e.g. "en0"). */
  id: string
  device: string
  displayName: string
  addresses: NetworkAddress[]
  kind: NetworkInterfaceKind
  mac?: string
}

interface ProbeResultBase {
  requestedUrl: string
  /** URL after following redirects — this is what the download should actually fetch. */
  finalUrl: string
  supportsRanges: boolean
  /** null when the server did not report a size. */
  totalBytes: number | null
  suggestedFileName: string
  contentType: string | null
  /** Strong validators, used to detect if the remote content changes between pause and resume. */
  etag: string | null
  lastModified: string | null
}

export interface MediaVariant {
  id: string
  url: string
  /** Separate HLS audio rendition when the selected video variant references one. */
  audioUrl?: string
  label: string
  width: number | null
  height: number | null
  bandwidth: number | null
  codecs: string | null
}

export interface MediaStreamInfo {
  protocol: 'hls' | 'dash'
  manifestUrl: string
  variants: MediaVariant[]
  live: false
  drm: false
  requiresFfmpeg: true
}

export interface MetalinkFileCandidate {
  name: string
  size?: number
  sha256?: string
  mirrors: { url: string; priority: number }[]
}

export interface HttpProbeResult extends ProbeResultBase {
  kind: 'http'
  /** Explicit transport for non-HTTP files served by FTP/FTPS. */
  transferProtocol?: 'http' | 'https' | 'ftp' | 'ftps'
  /** True when this FTP link supplied user credentials that need protected persistence. */
  ftpCredentialsRequired?: boolean
  /** Parsed Metalink manifest; the dialog lets the user pick a file entry. */
  metalink?: { manifestUrl: string; files: MetalinkFileCandidate[] }
  /** Present when this URL is a supported, non-DRM on-demand HLS/DASH manifest. */
  media?: MediaStreamInfo
}

export interface TorrentProbeResult extends ProbeResultBase {
  kind: 'torrent'
  torrent: TorrentInfo
}

export type ProbeResult = HttpProbeResult | TorrentProbeResult

export interface TorrentInfo {
  infoHash: string
  pieceLength: number
  /** Where each file will be written, relative to the destination folder, already checked to be
   * safe (see main/download/torrent/paths.ts). */
  files: { path: string; length: number }[]
}

/** One of a torrent download's files, for listing them while it runs. */
export interface TorrentFileEntry {
  /** As TorrentInfo's: relative to the destination folder, the torrent's own folder first. */
  path: string
  length: number
  /** Chosen to be downloaded. */
  chosen: boolean
  /** Piece-selection priority: 0 low, 1 normal, 2 high. */
  priority: 0 | 1 | 2
}

/** `queued`: waiting for one of the downloads running at once to end (see
 * AppSettings.downloadsAtOnce). */
export type DownloadStatus =
  'queued' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'

/** An HTTP stream's state. `pending` means it is waiting for work: it holds no block, either because
 * none is free for it right now or because it hasn't started. `downloading` always means it is
 * fetching one (`currentBlockIndex` says which). A stream that fails for good leaves the list;
 * what went wrong is its network's to report (see DownloadNetwork). */
export type HttpStreamStatus =
  'pending' | 'downloading' | 'retrying' | 'paused' | 'completed' | 'cancelled'

/** One connection to the server, through one network. Streams come and go as the download
 * runs; what a network has done is kept on its DownloadNetwork. */
export interface HttpStreamState {
  id: number
  /** The network it runs on: a DownloadNetwork's id. */
  interfaceId: string
  rangeStart: number
  /** null means an open-ended range (download to end of file). */
  rangeEnd: number | null
  /** New bytes it has delivered. */
  bytesDownloaded: number
  speedBytesPerSec: number
  status: HttpStreamStatus
  /** The block this stream is fetching. Unset whenever it holds none (idle, retrying, paused, done). */
  currentBlockIndex?: number
  /** True while this stream is racing another stream for `currentBlockIndex`, because that one
   * was too slow — see main/download/scheduler.ts. Whichever finishes first wins. */
  hedge?: boolean
}

/** A live BitTorrent peer connection. A peer does not own a piece: it may contribute blocks to
 * several pieces, and several peers may contribute to one piece. */
export interface TorrentPeerState {
  /** Unique in the download, in the order its peers connected: "Peer #(id + 1)". */
  id: number
  interfaceId: string
  status: 'connected' | 'receiving'
  /** The client it runs, as its peer id names it ("qBittorrent 4.6.2"); null when unknown. */
  client: string | null
  bytesDownloaded: number
  speedBytesPerSec: number
  bytesUploaded: number
  uploadSpeedBytesPerSec: number
}

export type HttpBlockStatus = 'pending' | 'downloading' | 'completed'
/** `skipped`: a piece that none of the files chosen for this torrent needs. */
export type TorrentPieceStatus = HttpBlockStatus | 'skipped'

interface WorkUnitState {
  index: number
  rangeStart: number
  rangeEnd: number | null
  /** The network currently leasing this block (or the last one to touch it). Only meaningful
   * as "who is working on it now" — for who actually *delivered* the bytes, read
   * `bytesByInterface`, since a block can be started on one network and finished on another
   * after a retry or a pause/resume. */
  interfaceId?: string
  bytesDownloaded: number
  /** Bytes of this block delivered by each network, keyed by interface id. Summing to
   * `bytesDownloaded`, this is what the block grid colors by, so a block split across
   * networks is attributed to all of them instead of only the one that happened to finish it. */
  bytesByInterface: Record<string, number>
}

export interface HttpBlockState extends WorkUnitState {
  kind: 'http'
  status: HttpBlockStatus
}

export interface TorrentPieceState extends WorkUnitState {
  kind: 'torrent'
  status: TorrentPieceStatus
  /** Bytes received in this run but not yet hash-verified. This is live activity, not durable
   * progress, and may fall back to zero after a failed verification. */
  provisionalBytes: number
}

export type DownloadUnitState = HttpBlockState | TorrentPieceState

/**
 * - on: in use.
 * - off: the user switched it off. A network that turns up mid-download starts off.
 * - offline: not connected to this computer. It's used again as soon as it is.
 * - unreachable: connected, but the server can't be reached through it. One connection keeps
 *   trying, and the rest follow once it gets through.
 * - failed: the server kept refusing requests over it (`error` says how). Switching it off and
 *   on, reconnecting it, or resuming tries again.
 * - limit: it has used up its data for the chosen period (NetworkPreference.dataLimit). It's used again
 *   once the period ends or the limit is raised.
 */
export type NetworkStatus = 'on' | 'off' | 'offline' | 'unreachable' | 'failed' | 'limit'

/** A network as one download sees it: whether the user has it on, and how it is doing. */
interface DownloadNetworkBase {
  /** A NetworkInterfaceInfo id. */
  id: string
  /** Its name and kind as the OS last reported them. */
  label: string
  kind: NetworkInterfaceKind
  /** The user's choice; `status` is what came of it. */
  enabled: boolean
  status: NetworkStatus
  error?: string
  /** Bytes of the file it delivered. */
  bytesDownloaded: number
  speedBytesPerSec: number
  /** Requests over it that failed and were tried again. */
  retries: number
}

export interface HttpDownloadNetwork extends DownloadNetworkBase {
  transfer: 'http'
}

export interface TorrentDownloadNetwork extends DownloadNetworkBase {
  transfer: 'torrent'
  bytesUploaded: number
  uploadSpeedBytesPerSec: number
}

export type DownloadNetwork = HttpDownloadNetwork | TorrentDownloadNetwork

interface DownloadStateBase {
  id: string
  url: string
  fileName: string
  /** Optional grouping label for related downloads, e.g. a domain-derived package. */
  packageName?: string
  destinationPath: string
  /** 0 means the size could not be determined ahead of time. */
  totalBytes: number
  bytesDownloaded: number
  speedBytesPerSec: number
  /** Optional per-download receive cap shared across all of this task's connections. */
  maxDownloadSpeedBytesPerSecond?: number
  /** Optional per-torrent upload cap, enforced by its dedicated WebTorrent client. */
  maxUploadSpeedBytesPerSecond?: number
  /** Queue priority: 0 low, 1 normal (default), 2 high. */
  priority?: 0 | 1 | 2
  /** Seconds left at this speed, smoothed (see updateTimeLeft); unset when there's no telling:
   * the size unknown, or nothing moving. */
  timeLeftSeconds?: number
  status: DownloadStatus
  error?: string
  /** For an error: whether resuming can pick up where it stopped. False when the progress was
   * thrown away, e.g. the file changed on the server. */
  resumable?: boolean
  startedAt: number
  /** Enrolled in the scheduled queue; survives relaunches until manually paused. */
  scheduled?: boolean
  /** While queued: its place in the queue, lowest first. */
  queuedAt?: number
  /** User-visible explanation when a task is queued behind a schedule or unsupported policy. */
  queueReason?: string
  pausedAt?: number
  totalPausedMs?: number
  completedAt?: number
  /** Each network's speed, by network id, sampled once a second over the last minute it ran.
   * Every series is as long as the others, so they line up in time. */
  speedHistory?: Record<string, number[]>
  /** The best combined speed held for a few seconds, so it only ever rises; unset until it has
   * run that long. A download done sooner gets the best speed it showed. */
  peakSpeedBytesPerSec?: number
  /** The update this state is as of (see DownloadUpdate). */
  seq?: number
}

export interface HttpDownloadState extends DownloadStateBase {
  kind: 'http'
  networks: HttpDownloadNetwork[]
  streams: HttpStreamState[]
  peakStreams: number
  blocks: HttpBlockState[]
  totalBlocks: number
  blockSizeBytes: number
  /** The disk can't keep up: most streams are waiting for their writes (see concurrency.ts). */
  diskLimited?: boolean
  fromBrowser?: string
}

export interface TorrentDownloadState extends DownloadStateBase {
  kind: 'torrent'
  networks: TorrentDownloadNetwork[]
  peers: TorrentPeerState[]
  peakPeers: number
  pieces: TorrentPieceState[]
  totalPieces: number
  pieceLength: number
  /** How many files it has, how many are chosen, and which (by index; unset: every one). */
  files: { chosen: number; total: number; selected?: number[] }
  /** Its files come in the torrent's folder (`fileName`), rather than as one file. */
  folder: boolean
  /** Of `totalBytes`, the bytes of pieces that no chosen file needs. */
  skippedBytes: number
  bytesUploaded: number
  uploadSpeedBytesPerSec: number
  /** 0 means explicit opt-in to seed until manually stopped; positive values are ratio caps. */
  uploadRatioLimit?: number
  /** True after the configured ratio limit has stopped uploads for this task. */
  uploadRatioReached?: boolean
  /** The completed payload is being shared until its configured ratio limit is reached or manually stopped. */
  seeding?: boolean
  /** Latest non-fatal WebTorrent discovery warning (tracker, DHT, or local discovery). */
  discoveryWarning?: string
  /** Additional announce URLs configured for this task. */
  customTrackers?: string[]
  /** Per-file piece priorities in metadata order. */
  filePriorities?: (0 | 1 | 2)[]
}

export type DownloadState = HttpDownloadState | TorrentDownloadState

/** A finished download as history keeps it: its state without the work units and connections,
 * which only a running download needs. */
export type FinishedDownload = (
  Omit<HttpDownloadState, 'blocks' | 'streams'> | Omit<TorrentDownloadState, 'pieces' | 'peers'>
) & {
  /** The blocks or pieces it was written in (a torrent's: those its chosen files needed). */
  unitsWritten: number
  /** Set when listed: its file or folder is no longer where it was saved. */
  missing?: boolean
  /** When the user removed this completed item from the main list; record remains in history. */
  removedAt?: number
  /** Chosen torrent files relative to its destination folder, retained for safe file removal. */
  downloadedFiles?: string[]
  /** SHA-256 computed locally after publication; not a trusted publisher checksum. */
  sha256?: string
  /** A file's bytes, or a deterministic path+bytes digest for a folder of selected files. */
  sha256Scope?: 'file' | 'tree'
}

/** What the main process sends as a download changes: everything but its blocks, and only the
 * blocks that changed since it last sent. A download can have tens of thousands of blocks, and
 * copying every one several times a second would cost the process that carries every byte. A
 * snapshot is the same with every block in it. */
export interface HttpDownloadUpdate {
  seq: number
  state: Omit<HttpDownloadState, 'blocks'>
  blocks: HttpBlockState[]
}

export interface TorrentDownloadUpdate {
  seq: number
  state: Omit<TorrentDownloadState, 'pieces'>
  pieces: TorrentPieceState[]
}

export type DownloadUpdate = HttpDownloadUpdate | TorrentDownloadUpdate

/** User customization for one physical network, keyed by NetworkInterfaceInfo.id — lets a
 * cryptic OS device name (e.g. "feth0") get a real label, and a color distinct from its
 * kind's default. Persisted in the main process, independent of any single download. */
export type DataLimitPeriod = 'day' | 'week' | 'month'

export interface NetworkPreference {
  customName?: string
  /** One of the app's curated swatch ids (see NETWORK_COLOR_SWATCHES) — not a raw hex, so every
   * swatch is guaranteed to have a legible on-solid text color already picked out for it. */
  colorId?: string
  /** Left out of the last download started, so New download starts without it too (it remembers
   * the last pick, like the folder). A click there puts it back. */
  off?: boolean
  /** Bytes a second all downloads together may take over it. */
  speedLimit?: number
  /** Bytes Sonic may receive in the chosen calendar period. */
  dataLimit?: number
  /** Defaults to month for existing settings. Weeks start Monday in local time. */
  dataLimitPeriod?: DataLimitPeriod
}

export type NetworkPreferences = Record<string, NetworkPreference>

/** Where the app's own update is (see main/updater.ts). `version` is the update's, once one is
 * found; `percent` only means something while downloading. */
/** A repeating window for all transfers, interpreted in the computer's local timezone. */
export interface DownloadSchedule {
  enabled: boolean
  /** Minutes since local midnight. Equal start/stop times are invalid. */
  startMinute: number
  endMinute: number
  /** Days on which a window starts, Sunday = 0. */
  days: number[]
  /** Last local date on which a window may start (YYYY-MM-DD). */
  endDate?: string
}

/** What app-settings.json holds, and what the renderer sends to change it (merged over the saved
 * values, `undefined` clearing one). A missing field was never set. */
export type CompletionAction = 'none' | 'notify' | 'open'

export type DestinationRuleMatch = 'extension' | 'domain'
export interface DestinationRule {
  id: string
  match: DestinationRuleMatch
  pattern: string
  destinationDir: string
  enabled: boolean
}

export interface AppSettings {
  /** Optional action after a task finishes; opening files is explicit opt-in. */
  completionAction?: CompletionAction
  downloadSchedule?: DownloadSchedule
  themeSource?: ThemeSource
  /** The last destination folder picked. */
  destinationDir?: string
  /** User customizations (name/color) per network interface id. */
  networkPreferences?: NetworkPreferences
  /** How many downloads run at once; the rest wait in the queue. */
  downloadsAtOnce?: number

  /** While on, slowModeSpeed stands in for speedLimit: a one-click lower limit for calls. */
  slowMode?: boolean
  slowModeSpeed?: number
  /** How speeds are shown everywhere; sizes stay in bytes either way. */
  speedUnit?: SpeedUnit
  browserExtensionUsed?: boolean
  /** User-defined labels available for organizing downloads. */
  customTags?: string[]
  /** Download ID to user-assigned tags, including history entries. */
  downloadTags?: Record<string, string[]>
  /** Ordered first-match destination rules for extension or source domain. */
  destinationRules?: DestinationRule[]
  /** Ed25519 publisher key manually pinned by its independently verified SHA-256 fingerprint. */
  publisherPublicKeyPem?: string
  publisherKeyFingerprint?: string
  /** Optional GitHub owner/repository for the release updater. */
  updateRepository?: string
  autoUpdateEnabled?: boolean
}

/** bytes: MB/s. bits: Mbps, as internet plans and speed tests count them. */
export type SpeedUnit = 'bytes' | 'bits' | 'KB/s' | 'MB/s' | 'GB/s' | 'KBps' | 'MBps' | 'GBps'

export const DOWNLOADS_AT_ONCE = { default: 2, min: 1, max: 4 }
/** Seconds of speed history a download keeps (a sample a second), and so the span the throughput
 * chart always shows. */
export const SPEED_HISTORY_SECONDS = 60
export const DEFAULT_SLOW_MODE_SPEED = 2 * 1024 ** 2

/** Everything the renderer needs for its first paint, read synchronously by the preload so no
 * saved value flashes in over a default a moment after launch. */
export interface RecoveryIssue {
  id: string
  message: string
  manifestPath: string
}

export interface InitialState {
  /** Runtime metadata used by privacy-safe diagnostics; never includes user or device IDs. */
  appVersion?: string
  electronVersion?: string
  nodeVersion?: string
  completionAction?: CompletionAction
  downloadSchedule?: DownloadSchedule
  homeDir: string
  downloadsDir: string
  themeSource: ThemeSource
  networkPreferences: NetworkPreferences
  downloadsAtOnce: number
  slowMode: boolean
  slowModeSpeed: number
  speedUnit: SpeedUnit
  /** The last folder picked, if it still exists — otherwise the renderer uses downloadsDir. */
  destinationDir?: string
  customTags: string[]
  downloadTags: Record<string, string[]>
  destinationRules: DestinationRule[]
  publisherPublicKeyPem?: string
  publisherKeyFingerprint?: string
  updateRepository?: string
  autoUpdateEnabled?: boolean
}

interface StartDownloadRequestBase {
  url: string
  destinationDir: string
  suggestedFileName: string
  /** Optional grouping label shared by related items imported together. */
  packageName?: string
  /** 0 means unknown. */
  totalBytes: number
  supportsRanges: boolean
  /** The networks to start on. Every other one starts switched off. */
  interfaceIds: string[]
  etag: string | null
  lastModified: string | null
}

export interface StartHttpDownloadRequest extends StartDownloadRequestBase {
  kind: 'http'
  /** Streams per network the user picked; left out, the count is decided automatically. */
  streamsPerNetwork?: number
  browser?: BrowserContext
  /** Present for an explicitly selected, non-DRM media variant. */
  mediaStream?: {
    protocol: 'hls' | 'dash'
    manifestUrl: string
    variantId: string
    variantUrl: string
    audioUrl?: string
  }
  /** Alternate HTTP(S) URLs; main process verifies identical content before enabling them. */
  mirrorUrls?: string[]
  /** Trusted Metalink publisher checksum, verified against the complete output before publication. */
  expectedSha256?: string
  /** FTP credentials stay in memory and are encrypted separately in persisted manifests. */
  ftpCredentials?: { username: string; password: string }
  /** Persists the fact that auth was required without persisting a clear-text credential. */
  ftpCredentialsRequired?: boolean
  /** Local source address chosen for the current FTP route; recomputed when a new task is started. */
  ftpLocalAddress?: string
}

/** The fields of chrome.cookies.Cookie that decide where it's sent. */
export interface BrowserCookie {
  name: string
  value: string
  /** With or without a leading dot: `hostOnly` decides whether subdomains get it. */
  domain: string
  hostOnly: boolean
  path: string
  secure: boolean
}

/** So a link that needs a signed-in session, or checks the page it came from, works as it does
 * in the browser. */
export interface BrowserContext {
  cookies: BrowserCookie[]
  referer?: string
  userAgent?: string
  name?: string
}

export interface PendingLink {
  id: string
  url: string
  /** Browser extension opt-in to starting without an extra confirmation click. */
  autoStart?: boolean
  /** Reused by New download: checking a single-use link again would spend it. */
  probe?: ProbeResult
  from?: string
  signedInTo?: string
  /** A failed download this looks like the same file as, for the user to resume instead. */
  resumes?: { id: string; fileName: string }
}

export interface StartTorrentDownloadRequest extends StartDownloadRequestBase {
  kind: 'torrent'
  /** The download starts from the .torrent retained when this info hash was probed. */
  infoHash: string
  /** For a torrent: the files to download, as indexes into its probe's `files`. Left out: all. */
  selectedFiles?: number[]
  /** Optional additional announce URLs, validated in the main process and persisted with the task. */
  customTrackers?: string[]
  /** Per-file piece priorities; indexes match the torrent's metadata file order. */
  filePriorities?: (0 | 1 | 2)[]
}

export type StartDownloadRequest = StartHttpDownloadRequest | StartTorrentDownloadRequest

/** Explicit, bounded site-mirror dry-run. The main process enforces these limits again. */
export interface SiteMirrorRequest {
  url: string
  termsConfirmed: boolean
  maxDepth: number
  maxPages: number
  delayMs: number
  extensions: string[]
}

export interface SiteMirrorProgress {
  pagesRequested: number
  maxPages: number
  pagesVisited: number
  candidateCount: number
  blockedByRobots: number
  currentPath: string
}

export interface SiteMirrorProgressEvent extends SiteMirrorProgress {
  operationId: string
}

export interface SiteMirrorPreview {
  startUrl: string
  pagesVisited: number
  links: string[]
  blockedByRobots: number
  issues: string[]
  truncated: boolean
  cancelled: boolean
}

export type MediaConversionFormat = 'mp4' | 'mkv' | 'webm' | 'mp3' | 'wav' | 'ogg' | 'flac'
export interface MediaConversionOptions {
  ffmpegPath: string
  expectedSha256: string
  outputDir: string
  format: MediaConversionFormat
}
export interface MediaConversionProgress {
  operationId: string
  downloadId: string
  status: 'running' | 'completed' | 'error' | 'cancelled'
  outputPath?: string
  message?: string
}
