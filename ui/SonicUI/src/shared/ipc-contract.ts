import type { PluginReview, PluginSummary, SonicPluginPermission } from './pluginApi'
import type {
  AppSettings,
  MediaConversionOptions,
  DownloadUpdate,
  FinishedDownload,
  RecoveryIssue,
  NetworkInterfaceInfo,
  PendingLink,
  ProbeResult,
  StartDownloadRequest,
  TorrentFileEntry
} from './types'

/** The request/response half of the IPC surface (every IpcChannels entry except the
 * main->renderer push events, downloadUpdated, networksChanged, historyChanged, linkReceived and
 * updateStateChanged) Ã¢â‚¬â€ one source of truth for
 * both sonicApi (preload) and registerIpcHandlers (main), so a signature drift between the two
 * is a compile error instead of a runtime one. */
export interface IpcContract {
  minimizeWindow: { args: []; result: void }
  toggleMaximizeWindow: { args: []; result: void }
  closeWindow: { args: []; result: void }
  listInterfaces: { args: []; result: NetworkInterfaceInfo[] }
  deviceBindingSupported: { args: []; result: boolean }
  openNetworkSettings: { args: []; result: void }
  updateSettings: { args: [patch: AppSettings]; result: void }
  probeUrl: { args: [url: string]; result: ProbeResult }
  checkForUpdate: {
    args: [repository: string]
    result: {
      configured: boolean
      currentVersion: string
      latestVersion?: string
      updateAvailable?: boolean
      releaseNotes?: string
      releaseUrl?: string
      publishedAt?: string
      assetUrl?: string
      assetName?: string
      assetSha256?: string
      verificationError?: string
      error?: string
    }
  }
  downloadVerifiedUpdate: {
    args: [repository: string]
    result: { operationId: string; fileName: string; sha256: string }
  }
  openVerifiedUpdate: { args: [operationId: string]; result: { opened: boolean; error?: string } }
  fingerprintPublisherKey: { args: [publicKeyPem: string]; result: string }
  verifyPublisherManifest: {
    args: [manifestJson: string, publicKeyPem: string, expectedFingerprint: string]
    result: { valid: boolean; publicKeyFingerprint: string; keyId?: string; payload: string }
  }
  verifyFileSha256: {
    args: [expectedHash: string]
    result:
      | { cancelled: true }
      | {
          cancelled: false
          fileName: string
          ok: boolean
          algorithm: 'SHA-256'
          expected: string
          actual: string
          meaning: 'integrity-only'
        }
  }
  /** Bounded same-origin site-mirror dry run; does not queue or download files. */
  previewSiteMirror: {
    args: [request: import('./types').SiteMirrorRequest, operationId: string]
    result: import('./types').SiteMirrorPreview
  }
  cancelSiteMirror: { args: [operationId: string]; result: void }
  chooseDestinationFolder: { args: [defaultPath: string]; result: string | null }
  chooseTorrentFile: { args: []; result: string | null }
  readClipboardText: { args: []; result: string }
  /** Shows a download's file in its folder, by the download's own path. False when nothing is
   * there any more: history is re-sent, with it marked missing. */
  revealDownload: { args: [id: string]; result: boolean }
  /** Opens a download's file (a torrent's folder) with the OS default. False when it's gone or
   * nothing could open it. */
  openDownload: { args: [id: string]; result: boolean }
  /** `linkId`: the PendingLink whose browser sign-in it starts with. */
  startDownload: { args: [request: StartDownloadRequest, linkId?: string]; result: string }
  /** Every download, oldest first, each as a snapshot. */
  listDownloads: { args: []; result: DownloadUpdate[] }
  /** Recovery problems found while restoring saved downloads; saved files are preserved. */
  listRecoveryIssues: { args: []; result: RecoveryIssue[] }
  /** Finished downloads, newest first. One is forgotten with removeDownload. */
  listHistory: { args: []; result: FinishedDownload[] }
  /** Forgets every finished download; their files stay. */
  clearHistory: { args: []; result: void }
  /** Bytes each network has received in its selected calendar period, by id (see NetworkPreference.dataLimit). */
  networkUsage: { args: []; result: Record<string, number> }
  resetNetworkUsage: { args: [id: string]; result: void }
  /** Bytes free on the drive holding `dir`; null when it can't be told. */
  freeSpace: { args: [dir: string]; result: number | null }
  /** A torrent download's files, in the torrent's order; empty for any other download. */
  torrentFiles: { args: [id: string]; result: TorrentFileEntry[] }
  /** Which of a torrent download's files to fetch, by index, as it runs or not. Refused for one
   * already downloaded, or with no room on disk for what's added. */
  chooseTorrentFiles: { args: [id: string, selected: number[]]; result: void }
  /** Set the priority for one torrent file (0 low, 1 normal, 2 high). */
  setTorrentFilePriority: {
    args: [id: string, fileIndex: number, priority: 0 | 1 | 2]
    result: void
  }
  /** Replace a torrent's custom announce URLs; an empty list removes all custom entries. */
  setTorrentTrackers: { args: [id: string, trackers: string[]]; result: void }
  /** Open a short-lived loopback stream for a selected, supported media file in an active torrent. */
  previewTorrentFile: { args: [id: string, fileIndex: number]; result: void }
  /** Open a tokenized loopback preview for an active sequential HTTP media download. */
  previewHttpMedia: { args: [id: string]; result: void }
  canPreviewHttpMedia: { args: [id: string]; result: boolean }
  chooseFfmpegExecutable: { args: []; result: { path: string; sha256: string } | null }
  startMediaConversion: { args: [id: string, options: MediaConversionOptions]; result: string }
  cancelMediaConversion: { args: [operationId: string]; result: void }
  listPlugins: { args: []; result: { trustedKeyIds: string[]; plugins: PluginSummary[] } }
  reviewPluginManifest: { args: [manifestJson: string]; result: PluginReview }
  trustPluginKey: { args: [keyId: string, publicKeyPem: string]; result: void }
  revokePluginKey: { args: [keyId: string]; result: void }
  installPlugin: { args: [manifestJson: string]; result: PluginSummary }
  setPluginPermissions: {
    args: [pluginId: string, permissions: SonicPluginPermission[]]
    result: PluginSummary
  }
  setPluginEnabled: { args: [pluginId: string, enabled: boolean]; result: PluginSummary }
  uninstallPlugin: { args: [pluginId: string]; result: void }
  rollbackPlugin: { args: [pluginId: string]; result: PluginSummary }
  pauseDownload: { args: [id: string]; result: void }
  resumeDownload: { args: [id: string]; result: void }
  /** A fresh link to the same file, for a download whose link stopped working; it resumes. */
  relinkDownload: { args: [id: string, url: string]; result: void }
  setDownloadNetwork: { args: [id: string, networkId: string, enabled: boolean]; result: void }
  /** Set a per-download receive cap in bytes per second; null clears the cap. */
  setDownloadSpeedLimit: { args: [id: string, bytesPerSecond: number | null]; result: void }
  /** Change queue priority (0 low, 1 normal, 2 high). */
  setDownloadPriority: { args: [id: string, priority: 0 | 1 | 2]; result: void }
  /** Set a per-torrent upload cap in bytes per second; null clears the cap. */
  setUploadSpeedLimit: { args: [id: string, bytesPerSecond: number | null]; result: void }
  /** Stop uploads once a torrent's uploaded/downloaded ratio reaches the limit; null disables it. */
  setUploadRatioLimit: { args: [id: string, ratio: number | null]; result: void }
  /** Ask an active torrent to announce to its configured trackers again. */
  refreshTorrentTrackers: { args: [id: string]; result: void }
  /** Stop post-completion seeding and archive the finished torrent in history. */
  stopSeeding: { args: [id: string]; result: void }
  cancelDownload: { args: [id: string]; result: void }
  /** Removes a download, cancelling one under way. A finished one's file stays, unless
   * `trashFile`: then it goes to the Trash. */
  removeDownload: { args: [id: string, options?: { trashFile?: boolean }]; result: void }
  /** Oldest first: every link not yet started or dismissed. */
  pendingLinks: { args: []; result: PendingLink[] }
  /** Resumes the failed download a link was matched to, from that link (see relinkDownload). */
  resumeFromLink: { args: [linkId: string, downloadId: string]; result: void }
  /** Forgets the sign-in of a link that won't be started. */
  dismissLink: { args: [id: string]; result: void }
  /** Saves a privacy-sanitized JSON diagnostic report using a native user-selected path. */
  saveDiagnosticReport: { args: [content: string]; result: boolean }
  exportStorageBackup: { args: []; result: boolean }
  restoreStorageBackup: {
    args: []
    result: {
      settingsRestored: boolean
      historyEntries: number
      tasksRestored: number
      mediaTasksRestored: number
    } | null
  }
  configurePortableStorage: { args: []; result: string | null }
  getStorageInfo: { args: []; result: { userDataDir: string; portable: boolean } }
  remoteControlState: { args: []; result: import('./types').RemoteControlState }
  enableRemoteControl: { args: [interfaceId: string]; result: import('./types').RemoteControlState }
  disableRemoteControl: { args: []; result: void }
  createRemotePairingCode: {
    args: [scopes: import('./types').RemoteControlScope[]]
    result: { code: string; expiresAt: number }
  }
  revokeRemoteDevice: {
    args: [deviceId: string]
    result: import('./types').RemoteControlState['devices']
  }
  exportRemoteCaCertificate: { args: []; result: boolean }
}
