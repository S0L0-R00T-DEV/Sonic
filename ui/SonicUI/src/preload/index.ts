import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IpcChannels } from '../shared/ipc-channels'
import type { IpcContract } from '../shared/ipc-contract'
import type {
  AppSettings,
  DownloadUpdate,
  InitialState,
  NetworkInterfaceInfo,
  SiteMirrorProgressEvent,
  MediaConversionProgress
} from '../shared/types'

// Register OS-file drag handlers in preload, before React mounts. On Windows, an external
// file drag can otherwise retain the prohibited-drop cursor if the page has not attached its
// handlers yet. The renderer's capture handlers still decide what to do with the dropped item.
window.addEventListener(
  'dragenter',
  (event) => {
    event.preventDefault()
  },
  true
)
window.addEventListener(
  'dragover',
  (event) => {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  },
  true
)
window.addEventListener(
  'drop',
  (event) => {
    // Prevent Chromium from navigating to a dropped file; the renderer handles valid inputs.
    event.preventDefault()
  },
  true
)

/** Typed wrapper around ipcRenderer.invoke — the channel name picks its args/result shape out of
 * IpcContract, so a call here that doesn't match what registerIpcHandlers (main) actually handles
 * is a compile error instead of a silent runtime mismatch. */
function invoke<K extends keyof IpcContract>(
  channel: K,
  ...args: IpcContract[K]['args']
): Promise<IpcContract[K]['result']> {
  return ipcRenderer.invoke(IpcChannels[channel], ...args)
}

const sonicApi = {
  platform: process.platform,
  // Sync on purpose — see InitialState. One small read, once, before the renderer's first paint.
  initialState: ipcRenderer.sendSync(IpcChannels.getInitialState) as InitialState,

  minimizeWindow: () => invoke('minimizeWindow'),
  toggleMaximizeWindow: () => invoke('toggleMaximizeWindow'),
  closeWindow: () => invoke('closeWindow'),
  listInterfaces: () => invoke('listInterfaces'),
  deviceBindingSupported: () => invoke('deviceBindingSupported'),
  openNetworkSettings: () => invoke('openNetworkSettings'),
  openBrowserExtensionPage: () => invoke('openBrowserExtensionPage', 'firefox'),
  copyBrowserExtensionFolderPath: () => invoke('copyBrowserExtensionFolderPath', 'firefox'),
  copyChromiumExtensionFolderPath: () => invoke('copyChromiumExtensionFolderPath'),
  updateSettings: (patch: AppSettings) => invoke('updateSettings', patch),
  probeUrl: (url: string) => invoke('probeUrl', url),
  checkForUpdate: (repository: string) => invoke('checkForUpdate', repository),
  getPendingVerifiedUpdate: () => invoke('getPendingVerifiedUpdate'),
  downloadVerifiedUpdate: (repository: string) => invoke('downloadVerifiedUpdate', repository),
  onUpdateDownloadProgress: (
    callback: (progress: import('../shared/types').UpdateDownloadProgress) => void
  ): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      progress: import('../shared/types').UpdateDownloadProgress
    ): void => callback(progress)
    ipcRenderer.on(IpcChannels.updateDownloadProgress, listener)
    return () => ipcRenderer.removeListener(IpcChannels.updateDownloadProgress, listener)
  },
  openVerifiedUpdate: (operationId: string) => invoke('openVerifiedUpdate', operationId),
  verifyFileSha256: (expectedHash: string) => invoke('verifyFileSha256', expectedHash),
  fingerprintPublisherKey: (publicKeyPem: string) =>
    invoke('fingerprintPublisherKey', publicKeyPem),
  verifyPublisherManifest: (
    manifestJson: string,
    publicKeyPem: string,
    expectedFingerprint: string
  ) => invoke('verifyPublisherManifest', manifestJson, publicKeyPem, expectedFingerprint),
  previewSiteMirror: (request: IpcContract['previewSiteMirror']['args'][0], operationId: string) =>
    invoke('previewSiteMirror', request, operationId),
  cancelSiteMirror: (operationId: string) => invoke('cancelSiteMirror', operationId),
  onSiteMirrorProgress: (callback: (progress: SiteMirrorProgressEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, progress: SiteMirrorProgressEvent): void =>
      callback(progress)
    ipcRenderer.on(IpcChannels.siteMirrorProgress, listener)
    return () => ipcRenderer.removeListener(IpcChannels.siteMirrorProgress, listener)
  },
  chooseDestinationFolder: (defaultPath: string) => invoke('chooseDestinationFolder', defaultPath),
  chooseTorrentFile: () => invoke('chooseTorrentFile'),
  /** Where a file dropped on the window is on disk ('' for one that isn't a file). */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  readClipboardText: () => invoke('readClipboardText'),
  revealDownload: (id: string) => invoke('revealDownload', id),
  openDownload: (id: string) => invoke('openDownload', id),
  startDownload: (request: IpcContract['startDownload']['args'][0], linkId?: string) =>
    invoke('startDownload', request, linkId),
  listDownloads: () => invoke('listDownloads'),
  listRecoveryIssues: () => invoke('listRecoveryIssues'),
  listHistory: () => invoke('listHistory'),
  clearHistory: () => invoke('clearHistory'),
  networkUsage: () => invoke('networkUsage'),
  resetNetworkUsage: (id) => invoke('resetNetworkUsage', id),
  freeSpace: (dir: string) => invoke('freeSpace', dir),
  torrentFiles: (downloadId: string) => invoke('torrentFiles', downloadId),
  chooseTorrentFiles: (downloadId: string, selected: number[]) =>
    invoke('chooseTorrentFiles', downloadId, selected),
  setTorrentFilePriority: (downloadId: string, fileIndex: number, priority: 0 | 1 | 2) =>
    invoke('setTorrentFilePriority', downloadId, fileIndex, priority),
  setTorrentTrackers: (downloadId: string, trackers: string[]) =>
    invoke('setTorrentTrackers', downloadId, trackers),
  previewTorrentFile: (downloadId: string, fileIndex: number) =>
    invoke('previewTorrentFile', downloadId, fileIndex),
  previewHttpMedia: (downloadId: string) => invoke('previewHttpMedia', downloadId),
  canPreviewHttpMedia: (downloadId: string) => invoke('canPreviewHttpMedia', downloadId),
  chooseFfmpegExecutable: () => invoke('chooseFfmpegExecutable'),
  startMediaConversion: (
    downloadId: string,
    options: IpcContract['startMediaConversion']['args'][1]
  ) => invoke('startMediaConversion', downloadId, options),
  cancelMediaConversion: (operationId: string) => invoke('cancelMediaConversion', operationId),
  onMediaConversionProgress: (
    callback: (progress: MediaConversionProgress) => void
  ): (() => void) => {
    const listener = (_event: IpcRendererEvent, progress: MediaConversionProgress): void =>
      callback(progress)
    ipcRenderer.on(IpcChannels.mediaConversionProgress, listener)
    return () => ipcRenderer.removeListener(IpcChannels.mediaConversionProgress, listener)
  },
  listPlugins: () => invoke('listPlugins'),
  reviewPluginManifest: (manifestJson: string) => invoke('reviewPluginManifest', manifestJson),
  trustPluginKey: (keyId: string, publicKeyPem: string) =>
    invoke('trustPluginKey', keyId, publicKeyPem),
  revokePluginKey: (keyId: string) => invoke('revokePluginKey', keyId),
  installPlugin: () => invoke('installPlugin'),
  setPluginPermissions: (
    pluginId: string,
    permissions: import('../shared/pluginApi').SonicPluginPermission[]
  ) => invoke('setPluginPermissions', pluginId, permissions),
  setPluginEnabled: (pluginId: string, enabled: boolean) =>
    invoke('setPluginEnabled', pluginId, enabled),
  uninstallPlugin: (pluginId: string) => invoke('uninstallPlugin', pluginId),
  rollbackPlugin: (pluginId: string) => invoke('rollbackPlugin', pluginId),
  pauseDownload: (downloadId: string) => invoke('pauseDownload', downloadId),
  resumeDownload: (downloadId: string) => invoke('resumeDownload', downloadId),
  relinkDownload: (downloadId: string, url: string) => invoke('relinkDownload', downloadId, url),
  setDownloadNetwork: (downloadId: string, networkId: string, enabled: boolean) =>
    invoke('setDownloadNetwork', downloadId, networkId, enabled),
  setDownloadSpeedLimit: (downloadId: string, bytesPerSecond: number | null) =>
    invoke('setDownloadSpeedLimit', downloadId, bytesPerSecond),
  setDownloadPriority: (downloadId: string, priority: 0 | 1 | 2) =>
    invoke('setDownloadPriority', downloadId, priority),
  setUploadSpeedLimit: (downloadId: string, bytesPerSecond: number | null) =>
    invoke('setUploadSpeedLimit', downloadId, bytesPerSecond),
  setUploadRatioLimit: (downloadId: string, ratio: number | null) =>
    invoke('setUploadRatioLimit', downloadId, ratio),
  refreshTorrentTrackers: (downloadId: string) => invoke('refreshTorrentTrackers', downloadId),
  stopSeeding: (downloadId: string) => invoke('stopSeeding', downloadId),
  cancelDownload: (downloadId: string) => invoke('cancelDownload', downloadId),
  removeDownload: (downloadId: string, options?: { trashFile?: boolean }) =>
    invoke('removeDownload', downloadId, options),
  pendingLinks: () => invoke('pendingLinks'),
  resumeFromLink: (linkId: string, downloadId: string) =>
    invoke('resumeFromLink', linkId, downloadId),
  dismissLink: (id: string) => invoke('dismissLink', id),
  saveDiagnosticReport: (content: string) => invoke('saveDiagnosticReport', content),
  exportStorageBackup: (kind: 'settings' | 'history') => invoke('exportStorageBackup', kind),
  restoreStorageBackup: () => invoke('restoreStorageBackup'),
  getStorageInfo: () => invoke('getStorageInfo'),
  remoteControlState: () => invoke('remoteControlState'),
  enableRemoteControl: (interfaceId: string) => invoke('enableRemoteControl', interfaceId),
  disableRemoteControl: () => invoke('disableRemoteControl'),
  createRemotePairingCode: (scopes: import('../shared/types').RemoteControlScope[]) =>
    invoke('createRemotePairingCode', scopes),
  revokeRemoteDevice: (deviceId: string) => invoke('revokeRemoteDevice', deviceId),
  exportRemoteCaCertificate: () => invoke('exportRemoteCaCertificate'),

  onUpdateDetected: (callback: (version: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, version: string): void => callback(version)
    ipcRenderer.on(IpcChannels.updateDetected, listener)
    return () => ipcRenderer.removeListener(IpcChannels.updateDetected, listener)
  },

  /** A user clicked the OS update notification; bring the About dialog forward. */
  onUpdateAvailable: (callback: (version: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, version: string): void => callback(version)
    ipcRenderer.on(IpcChannels.updateAvailable, listener)
    return () => ipcRenderer.removeListener(IpcChannels.updateAvailable, listener)
  },

  onLinkReceived: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IpcChannels.linkReceived, listener)
    return () => ipcRenderer.removeListener(IpcChannels.linkReceived, listener)
  },

  onSettingsChanged: (callback: (settings: AppSettings) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, settings: AppSettings): void => callback(settings)
    ipcRenderer.on(IpcChannels.settingsChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannels.settingsChanged, listener)
  },

  onDownloadUpdated: (callback: (update: DownloadUpdate) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, update: DownloadUpdate): void => callback(update)
    ipcRenderer.on(IpcChannels.downloadUpdated, listener)
    return () => ipcRenderer.removeListener(IpcChannels.downloadUpdated, listener)
  },

  /** A download was added to the finished ones or forgotten: listHistory() has them. */
  onHistoryChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IpcChannels.historyChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannels.historyChanged, listener)
  },

  onNetworksChanged: (callback: (networks: NetworkInterfaceInfo[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, networks: NetworkInterfaceInfo[]): void =>
      callback(networks)
    ipcRenderer.on(IpcChannels.networksChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannels.networksChanged, listener)
  }
}

export type SonicApi = typeof sonicApi

// Nothing in the renderer needs raw Electron/Node access — only the typed sonicApi above is
// exposed. The @electron-toolkit/preload electronAPI (which hands the renderer an unrestricted
// ipcRenderer.invoke/send/on on any channel) is deliberately not bridged.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('sonic', sonicApi)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.sonic = sonicApi
}
