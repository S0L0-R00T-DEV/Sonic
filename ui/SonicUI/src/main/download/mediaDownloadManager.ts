import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { app, Notification, shell, type BrowserWindow } from 'electron'
import type { CompletionAction } from '../../shared/types'
import type {
  DownloadUpdate,
  FinishedDownload,
  RecoveryIssue,
  HttpDownloadState,
  HttpDownloadUpdate,
  StartHttpDownloadRequest
} from '../../shared/types'
import { IpcChannels } from '../../shared/ipc-channels'
import { addToHistory, removeFromHistory } from './history'
import { hashCompletedOutput } from './outputHash'
import { reserveDestinationPath } from './paths'
import { inspectMediaManifest } from './mediaStreams'

interface MediaRuntime {
  state: HttpDownloadState
  request: StartHttpDownloadRequest
  tempPath: string
  child?: ChildProcess
  timer?: NodeJS.Timeout
  intentionalStop?: 'pause' | 'cancel'
  sequence: number
  lastBytes: number
  lastAt: number
  removed: boolean
  finishing: boolean
  /** DASH video representations are exposed by FFmpeg as ordered video streams. */
  videoStreamIndex: number
  /** Advertised source bitrate used to translate a receive cap into FFmpeg's read-rate factor. */
  estimatedBitrate?: number
  persistChain: Promise<void>
  lastPersistAt: number
}

type PersistedMediaManifest = {
  version: 1
  id: string
  state: Omit<HttpDownloadState, 'blocks' | 'streams'>
  request: StartHttpDownloadRequest
  videoStreamIndex?: number
}

function mediaStateRoot(): string {
  return join(app.getPath('userData'), 'media-downloads')
}

function mediaManifestPath(id: string): string {
  return join(mediaStateRoot(), `${id}.json`)
}

function mediaTempRoot(): string {
  return join(app.getPath('temp'), 'speed-of-freq-sonic-media')
}

function ffmpegCommand(): string {
  return process.env['SONIC_FFMPEG_PATH']?.trim() || 'ffmpeg'
}

function safeWebUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Selected media stream URL is invalid.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Media downloads only accept HTTP(S) stream URLs without embedded credentials.')
  }
  return url
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function verifiedMediaSelection(
  request: StartHttpDownloadRequest
): Promise<{ index: number; bandwidth: number | null }> {
  const stream = request.mediaStream
  if (!stream) throw new Error('A media stream variant must be selected.')
  safeWebUrl(stream.manifestUrl)
  safeWebUrl(stream.variantUrl)
  const protocolHint =
    stream.protocol === 'hls' ? 'application/vnd.apple.mpegurl' : 'application/dash+xml'
  const masterManifest = await inspectMediaManifest(stream.manifestUrl, protocolHint)
  const selectedVariantIndex =
    masterManifest?.variants.findIndex(
      (variant) =>
        variant.id === stream.variantId &&
        variant.url === stream.variantUrl &&
        (variant.audioUrl ?? undefined) === (stream.audioUrl ?? undefined)
    ) ?? -1
  const selectedVariant = masterManifest?.variants[selectedVariantIndex]
  if (
    !masterManifest ||
    masterManifest.protocol !== stream.protocol ||
    !selectedVariant ||
    selectedVariantIndex < 0
  ) {
    throw new Error(
      'The selected media representation does not match the verified source manifest.'
    )
  }
  if (stream.protocol === 'hls') {
    const variantManifest = await inspectMediaManifest(
      selectedVariant.url,
      'application/vnd.apple.mpegurl'
    )
    if (!variantManifest || variantManifest.protocol !== 'hls') {
      throw new Error('The selected HLS variant could not be verified as an on-demand playlist.')
    }
    if (stream.audioUrl) {
      safeWebUrl(stream.audioUrl)
      const audioManifest = await inspectMediaManifest(
        stream.audioUrl,
        'application/vnd.apple.mpegurl'
      )
      if (!audioManifest || audioManifest.protocol !== 'hls') {
        throw new Error(
          'The selected HLS audio rendition could not be verified as an on-demand playlist.'
        )
      }
    }
  }
  return { index: selectedVariantIndex, bandwidth: selectedVariant.bandwidth }
}

function normalizePersistedMedia(value: unknown, id: string): PersistedMediaManifest | undefined {
  if (!isRecord(value) || value.version !== 1 || value.id !== id) return undefined
  if (!isRecord(value.state) || !isRecord(value.request)) return undefined
  const state = value.state
  const request = value.request
  const stream = request.mediaStream
  if (
    state.kind !== 'http' ||
    state.id !== id ||
    !['queued', 'downloading', 'paused', 'error', 'completed', 'cancelled'].includes(
      String(state.status)
    ) ||
    typeof state.url !== 'string' ||
    typeof state.fileName !== 'string' ||
    typeof state.destinationPath !== 'string' ||
    typeof state.startedAt !== 'number' ||
    !Number.isFinite(state.startedAt) ||
    typeof state.totalBytes !== 'number' ||
    !Number.isFinite(state.totalBytes) ||
    typeof state.bytesDownloaded !== 'number' ||
    !Number.isFinite(state.bytesDownloaded) ||
    !Array.isArray(state.networks) ||
    request.kind !== 'http' ||
    typeof request.destinationDir !== 'string' ||
    typeof request.suggestedFileName !== 'string' ||
    !isRecord(stream) ||
    !['hls', 'dash'].includes(String(stream.protocol)) ||
    typeof stream.manifestUrl !== 'string' ||
    typeof stream.variantId !== 'string' ||
    typeof stream.variantUrl !== 'string'
  ) {
    return undefined
  }
  return {
    version: 1,
    id,
    state: state as unknown as PersistedMediaManifest['state'],
    request: { ...request, browser: undefined } as unknown as StartHttpDownloadRequest
  }
}

function finishedState(
  state: HttpDownloadState,
  hash: { sha256: string; scope: 'file' | 'tree' }
): FinishedDownload {
  const { blocks: _blocks, streams: _streams, ...rest } = state
  void _blocks
  void _streams
  return { ...rest, unitsWritten: 1, sha256: hash.sha256, sha256Scope: hash.scope }
}

export class MediaDownloadManager {
  private readonly runtimes = new Map<string, MediaRuntime>()
  private readonly recoveryIssuesById = new Map<string, RecoveryIssue>()
  private readonly initialization: Promise<void>

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly getCompletionAction: () => CompletionAction = () => 'notify',
    private readonly getSpeedPolicy: () => {
      speedLimit?: number
      networkSpeedLimit?: number
      slowMode?: boolean
      slowModeSpeed?: number
    } = () => ({})
  ) {
    this.initialization = this.cleanStaleTemps()
      .then(() => this.restorePersisted())
      .catch((error: unknown) => {
        console.error('[Speed-o-Freq Sonic] media recovery failed:', error)
      })
  }

  private async cleanStaleTemps(): Promise<void> {
    const root = mediaTempRoot()
    try {
      await mkdir(root, { recursive: true })
      const { readdir } = await import('node:fs/promises')
      const entries = await readdir(root, { withFileTypes: true })
      const cutoff = Date.now() - 24 * 60 * 60 * 1000
      for (const entry of entries) {
        if (!entry.isFile() || !/^sonic-media-[a-f0-9-]+\.part\.mp4$/i.test(entry.name)) continue
        const path = join(root, entry.name)
        const details = await stat(path).catch(() => null)
        if (details && details.mtimeMs < cutoff) await rm(path, { force: true }).catch(() => {})
      }
    } catch (error) {
      console.warn('[Speed-o-Freq Sonic] Could not clean stale media temp files:', error)
    }
  }

  ready(): Promise<void> {
    return this.initialization
  }

  recoveryIssues(): RecoveryIssue[] {
    return [...this.recoveryIssuesById.values()]
  }

  private recordRecoveryIssue(id: string, message: string, manifestPath: string): void {
    this.recoveryIssuesById.set(id, { id, message, manifestPath })
  }

  private async restorePersisted(): Promise<void> {
    const root = mediaStateRoot()
    await mkdir(root, { recursive: true })
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
      const id = entry.name.slice(0, -5)
      const path = join(root, entry.name)
      if (!/^[a-f0-9-]{36}$/i.test(id)) {
        this.recordRecoveryIssue(
          id,
          'Media manifest filename is not a valid task ID; the file was preserved.',
          path
        )
        continue
      }
      let manifest: PersistedMediaManifest | undefined
      try {
        manifest = normalizePersistedMedia(JSON.parse(await readFile(path, 'utf8')) as unknown, id)
      } catch (error) {
        this.recordRecoveryIssue(
          id,
          `Media manifest could not be read or parsed: ${error instanceof Error ? error.message : String(error)}`,
          path
        )
        continue
      }
      if (!manifest) {
        this.recordRecoveryIssue(
          id,
          'Media manifest is corrupt or uses an unsupported version; the file was preserved.',
          path
        )
        continue
      }

      const state: HttpDownloadState = {
        ...manifest.state,
        blocks: [],
        streams: [],
        speedBytesPerSec: 0,
        bytesDownloaded: Math.max(0, manifest.state.bytesDownloaded),
        totalBytes: Math.max(0, manifest.state.totalBytes)
      }
      const request = manifest.request
      const tempPath = join(mediaTempRoot(), `sonic-media-${id}.part.mp4`)
      if (state.status === 'cancelled') {
        await this.removeManifest(id)
        continue
      }
      if (state.status === 'completed') {
        try {
          const details = await stat(state.destinationPath)
          if (!details.isFile() || details.size <= 0)
            throw new Error('completed output is missing or empty')
          state.bytesDownloaded = details.size
          state.totalBytes = details.size
          await addToHistory(finishedState(state, await hashCompletedOutput(state.destinationPath)))
          await this.removeManifest(id)
          continue
        } catch (error) {
          state.status = 'error'
          state.error = `Completion recovery needs attention: ${error instanceof Error ? error.message : String(error)}`
          this.recordRecoveryIssue(id, state.error, path)
        }
      }

      const videoStreamIndex =
        typeof manifest.videoStreamIndex === 'number' &&
        Number.isSafeInteger(manifest.videoStreamIndex) &&
        manifest.videoStreamIndex >= 0
          ? manifest.videoStreamIndex
          : 0
      if (state.status === 'downloading') state.status = 'paused'
      state.speedBytesPerSec = 0
      state.bytesDownloaded = 0
      state.totalBytes = 0
      await rm(tempPath, { force: true }).catch(() => {})
      const runtime: MediaRuntime = {
        state,
        request,
        tempPath,
        sequence: 0,
        lastBytes: 0,
        lastAt: Date.now(),
        removed: false,
        finishing: false,
        videoStreamIndex,
        persistChain: Promise.resolve(),
        lastPersistAt: Date.now()
      }
      this.runtimes.set(id, runtime)
      await this.persist(runtime)
      this.pushUpdate(runtime)
    }
  }

  private async persist(runtime: MediaRuntime): Promise<void> {
    if (runtime.removed || runtime.state.status === 'cancelled') {
      await this.removeManifest(runtime.state.id)
      return
    }
    const operation = runtime.persistChain
      .catch(() => {})
      .then(async () => {
        const path = mediaManifestPath(runtime.state.id)
        const temporary = `${path}.${process.pid}.tmp`
        const { blocks: _blocks, streams: _streams, ...state } = runtime.state
        void _blocks
        void _streams
        const { browser: _browser, ...request } = runtime.request as StartHttpDownloadRequest & {
          browser?: unknown
        }
        void _browser
        await mkdir(mediaStateRoot(), { recursive: true })
        await writeFile(
          temporary,
          JSON.stringify(
            {
              version: 1,
              id: runtime.state.id,
              state,
              request,
              videoStreamIndex: runtime.videoStreamIndex
            },
            null,
            2
          ) + '\n',
          { encoding: 'utf8', mode: 0o600 }
        )
        await rename(temporary, path)
      })
    runtime.persistChain = operation
    await operation
  }

  private async removeManifest(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (runtime) await runtime.persistChain.catch(() => {})
    await Promise.all([
      rm(mediaManifestPath(id), { force: true }).catch(() => {}),
      rm(`${mediaManifestPath(id)}.${process.pid}.tmp`, { force: true }).catch(() => {})
    ])
  }

  has(id: string): boolean {
    return this.runtimes.has(id)
  }

  isActive(id: string): boolean {
    const state = this.runtimes.get(id)?.state
    return Boolean(state && ['downloading', 'paused', 'queued'].includes(state.status))
  }

  listDownloads(): DownloadUpdate[] {
    return [...this.runtimes.values()]
      .filter((runtime) => !runtime.removed && runtime.state.status !== 'completed')
      .map((runtime) => this.toUpdate(runtime))
  }

  async start(
    request: StartHttpDownloadRequest,
    queued = false,
    queueReason?: string
  ): Promise<string> {
    await this.initialization
    if (!request.mediaStream) throw new Error('A media stream variant must be selected.')
    const selection = await verifiedMediaSelection(request)
    const originalName = request.suggestedFileName.trim() || 'media.mp4'
    const baseName = originalName.replace(/\.[^.]+$/, '') || 'media'
    const normalizedRequest = { ...request, suggestedFileName: `${baseName}.mp4` }
    const id = randomUUID()
    const startedAt = Date.now()
    const tempPath = join(mediaTempRoot(), `sonic-media-${id}.part.mp4`)
    await mkdir(mediaTempRoot(), { recursive: true })
    const state: HttpDownloadState = {
      kind: 'http',
      id,
      url: request.mediaStream.manifestUrl,
      fileName: normalizedRequest.suggestedFileName,
      destinationPath: join(normalizedRequest.destinationDir, normalizedRequest.suggestedFileName),
      totalBytes: 0,
      bytesDownloaded: 0,
      speedBytesPerSec: 0,
      status: queued ? 'queued' : 'downloading',
      queuedAt: queued ? startedAt : undefined,
      queueReason: queued ? queueReason : undefined,
      startedAt,
      networks: [],
      streams: [],
      peakStreams: 1,
      blocks: [],
      totalBlocks: 0,
      blockSizeBytes: 64 * 1024
    }
    const runtime: MediaRuntime = {
      state,
      request: normalizedRequest,
      tempPath,
      sequence: 0,
      lastBytes: 0,
      lastAt: startedAt,
      removed: false,
      finishing: false,
      videoStreamIndex: request.mediaStream.protocol === 'dash' ? selection.index : 0,
      estimatedBitrate: selection.bandwidth ?? undefined,
      persistChain: Promise.resolve(),
      lastPersistAt: startedAt
    }
    this.runtimes.set(id, runtime)
    await this.persist(runtime)
    this.pushUpdate(runtime)
    if (!queued) this.run(runtime)
    return id
  }

  async setDownloadSpeedLimit(id: string, bytesPerSecond: number | null): Promise<void> {
    await this.initialization
    if (bytesPerSecond !== null && (!Number.isSafeInteger(bytesPerSecond) || bytesPerSecond <= 0)) {
      throw new Error(
        'A receive-speed cap must be a positive whole number of bytes per second, or cleared.'
      )
    }
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.state.status === 'completed' || runtime.state.status === 'cancelled') {
      throw new Error('Media download not found or no longer adjustable.')
    }
    const restartFromBeginning = runtime.state.status === 'downloading' && Boolean(runtime.child)
    if (restartFromBeginning && runtime.child) {
      // Media muxing cannot resume safely at arbitrary output offsets, so a live cap change restarts it.
      const child = runtime.child
      runtime.intentionalStop = 'pause'
      child.kill()
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out while applying the media speed cap.')),
          10_000
        )
        timeout.unref()
        child.once('close', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }
    runtime.state.maxDownloadSpeedBytesPerSecond = bytesPerSecond ?? undefined
    await this.persist(runtime)
    if (restartFromBeginning) this.run(runtime)
    else this.pushUpdate(runtime)
  }

  async setQueuedReasonForAll(reason: string | undefined): Promise<void> {
    await this.initialization
    for (const runtime of this.runtimes.values()) {
      if (runtime.state.status !== 'queued' || runtime.state.queueReason === reason) continue
      runtime.state.queueReason = reason
      await this.persist(runtime)
      this.pushUpdate(runtime)
    }
  }

  async startQueued(id: string): Promise<void> {
    await this.initialization
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.state.status !== 'queued') return
    const selection = await verifiedMediaSelection(runtime.request)
    runtime.videoStreamIndex =
      runtime.request.mediaStream?.protocol === 'dash' ? selection.index : 0
    runtime.estimatedBitrate = selection.bandwidth ?? undefined
    runtime.state.queuedAt = undefined
    this.run(runtime)
    this.pushUpdate(runtime)
  }

  private run(runtime: MediaRuntime): void {
    if (runtime.removed || runtime.state.status === 'completed') return
    const policy = this.getSpeedPolicy()
    const caps = [
      runtime.state.maxDownloadSpeedBytesPerSecond,
      policy.slowMode ? policy.slowModeSpeed : policy.speedLimit,
      policy.networkSpeedLimit
    ].filter(
      (value): value is number =>
        typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    )
    const cap = caps.length ? Math.min(...caps) : undefined
    if (cap && !runtime.estimatedBitrate) {
      runtime.state.status = 'error'
      runtime.state.error =
        'This media source does not advertise a bitrate, so Sonic cannot safely apply the configured receive-speed cap. Choose a source with bitrate metadata or clear the cap.'
      void this.persist(runtime).catch(() => {})
      this.pushUpdate(runtime)
      return
    }
    // FFmpeg readrate is relative to source media time, not a byte-perfect network shaper.
    // Derive a conservative playback-rate factor from the verified variant bitrate.
    const readRate =
      cap && runtime.estimatedBitrate
        ? Math.max(0.01, Math.min(1, (cap * 8) / runtime.estimatedBitrate))
        : undefined
    runtime.intentionalStop = undefined
    runtime.finishing = false
    runtime.state.status = 'downloading'
    runtime.state.queueReason = undefined
    runtime.state.error = undefined
    runtime.state.speedBytesPerSec = 0
    runtime.lastBytes = 0
    runtime.lastAt = Date.now()
    runtime.lastPersistAt = runtime.lastAt
    void this.persist(runtime).catch((error) =>
      console.warn('[Speed-o-Freq Sonic] could not persist media task start:', error)
    )
    this.pushUpdate(runtime)
    const stream = runtime.request.mediaStream!
    // Never invoke a shell. Restrict FFmpeg's input protocols so a playlist cannot pivot to file:, ftp:, or other local/network schemes.
    const args = [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-loglevel',
      'error',
      '-protocol_whitelist',
      'http,https,tcp,tls,crypto,data',
      ...(readRate ? ['-readrate', String(readRate)] : []),
      '-i',
      stream.variantUrl,
      ...(stream.audioUrl
        ? [
            '-protocol_whitelist',
            'http,https,tcp,tls,crypto,data',
            ...(readRate ? ['-readrate', String(readRate)] : []),
            '-i',
            stream.audioUrl
          ]
        : []),
      '-map',
      `0:v:${runtime.videoStreamIndex}?`,
      '-map',
      stream.audioUrl ? '1:a:0?' : '0:a:0?',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      '-nostats',
      runtime.tempPath
    ]
    const child = spawn(ffmpegCommand(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    runtime.child = child
    let progressBuffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      progressBuffer += chunk.toString('utf8')
      const lines = progressBuffer.split(/\r?\n/)
      progressBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('out_time_ms=')) {
          const microseconds = Number(line.slice('out_time_ms='.length))
          if (Number.isFinite(microseconds) && microseconds >= 0) {
            // Duration is not always available from a manifest; the output-file size is the authoritative progress measure.
            void this.refreshFileProgress(runtime)
          }
        }
      }
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-6000)
    })
    runtime.timer = setInterval(() => void this.refreshFileProgress(runtime), 750)
    runtime.timer.unref()
    child.once('error', (error) => {
      void this.finishFailure(
        runtime,
        error.message.includes('ENOENT')
          ? 'FFmpeg was not found. Install FFmpeg and add it to PATH, or set SONIC_FFMPEG_PATH to its executable.'
          : error.message
      )
    })
    child.once('close', (code) => {
      if (runtime.intentionalStop) {
        const action = runtime.intentionalStop
        runtime.child = undefined
        if (action === 'pause') {
          runtime.state.status = 'paused'
          runtime.state.speedBytesPerSec = 0
          void this.persist(runtime).catch((error) =>
            console.warn('[Speed-o-Freq Sonic] could not persist paused media task:', error)
          )
          this.pushUpdate(runtime)
        } else {
          void rm(runtime.tempPath, { force: true }).catch(() => {})
          runtime.state.status = 'cancelled'
          runtime.state.speedBytesPerSec = 0
          runtime.state.bytesDownloaded = 0
          void this.removeManifest(runtime.state.id)
          this.pushUpdate(runtime)
        }
        return
      }
      runtime.child = undefined
      if (code === 0) void this.finishSuccess(runtime)
      else
        void this.finishFailure(
          runtime,
          stderr.trim() || `FFmpeg exited with code ${String(code)}.`
        )
    })
  }

  private async refreshFileProgress(runtime: MediaRuntime): Promise<void> {
    if (runtime.removed || runtime.state.status !== 'downloading') return
    const details = await stat(runtime.tempPath).catch(() => null)
    if (!details?.isFile()) return
    const now = Date.now()
    const bytes = details.size
    const elapsed = Math.max(1, now - runtime.lastAt) / 1000
    runtime.state.bytesDownloaded = bytes
    runtime.state.speedBytesPerSec = Math.max(0, (bytes - runtime.lastBytes) / elapsed)
    runtime.lastBytes = bytes
    runtime.lastAt = now
    this.pushUpdate(runtime)
    if (now - runtime.lastPersistAt >= 15_000) {
      runtime.lastPersistAt = now
      void this.persist(runtime).catch((error) =>
        console.warn('[Speed-o-Freq Sonic] could not checkpoint media task:', error)
      )
    }
  }

  private async finishSuccess(runtime: MediaRuntime): Promise<void> {
    if (runtime.removed || runtime.finishing) return
    runtime.finishing = true
    clearInterval(runtime.timer)
    try {
      const details = await stat(runtime.tempPath)
      if (!details.isFile() || details.size <= 0)
        throw new Error('FFmpeg completed without producing a media file.')
      const hash = await hashCompletedOutput(runtime.tempPath)
      const destinationPath = await reserveDestinationPath(
        runtime.request.destinationDir,
        runtime.request.suggestedFileName
      )
      try {
        await rename(runtime.tempPath, destinationPath)
      } catch (error) {
        await rm(`${destinationPath}.sonic`, { force: true }).catch(() => {})
        throw error
      }
      await rm(`${destinationPath}.sonic`, { force: true }).catch(() => {})
      runtime.state.destinationPath = destinationPath
      runtime.state.fileName = basename(destinationPath)
      runtime.state.bytesDownloaded = details.size
      runtime.state.totalBytes = details.size
      runtime.state.speedBytesPerSec = 0
      runtime.state.status = 'completed'
      runtime.state.completedAt = Date.now()
      const history = finishedState(runtime.state, hash)
      // Checkpoint completion before updating history. Startup can finish the history write if
      // the app exits between these two durable operations.
      await this.persist(runtime).catch((error) =>
        console.warn('[Speed-o-Freq Sonic] could not checkpoint completed media task:', error)
      )
      await addToHistory(history)
      await this.removeManifest(runtime.state.id)
      this.pushUpdate(runtime)
      this.getWindow()?.webContents.send(IpcChannels.historyChanged)
      const action = this.getCompletionAction()
      if (action === 'open') {
        void shell.openPath(destinationPath).then((error) => {
          if (error)
            console.warn(
              '[Speed-o-Freq Sonic] completion action could not open media output:',
              error
            )
        })
      } else if (action === 'notify' && Notification.isSupported()) {
        new Notification({
          title: 'Download complete',
          body: `${runtime.state.fileName} has finished downloading.`
        }).show()
      }
    } catch (error) {
      await this.finishFailure(runtime, error instanceof Error ? error.message : String(error))
    } finally {
      runtime.finishing = false
    }
  }

  private async finishFailure(runtime: MediaRuntime, message: string): Promise<void> {
    if (
      runtime.removed ||
      runtime.intentionalStop ||
      runtime.state.status === 'error' ||
      runtime.state.status === 'completed'
    )
      return
    clearInterval(runtime.timer)
    runtime.child = undefined
    await rm(runtime.tempPath, { force: true }).catch(() => {})
    runtime.state.status = 'error'
    runtime.state.error = message.slice(0, 4000)
    runtime.state.speedBytesPerSec = 0
    runtime.state.bytesDownloaded = 0
    runtime.state.totalBytes = 0
    await this.persist(runtime).catch((error) =>
      console.warn('[Speed-o-Freq Sonic] could not persist media task failure:', error)
    )
    this.pushUpdate(runtime)
  }

  async pause(id: string): Promise<void> {
    await this.initialization
    const runtime = this.runtimes.get(id)
    if (!runtime || !['downloading', 'queued'].includes(runtime.state.status))
      throw new Error('Media download is not running or queued.')
    if (runtime.state.status === 'queued') {
      runtime.state.status = 'paused'
      runtime.state.queuedAt = undefined
      await this.persist(runtime)
      this.pushUpdate(runtime)
      return
    }
    runtime.intentionalStop = 'pause'
    runtime.child?.kill()
  }

  async resume(id: string): Promise<void> {
    await this.initialization
    const runtime = this.runtimes.get(id)
    if (!runtime || !['paused', 'error'].includes(runtime.state.status))
      throw new Error('Media download cannot be resumed.')
    // Re-validate the source before spawning FFmpeg; a saved task may point to an expired or changed manifest.
    const selection = await verifiedMediaSelection(runtime.request)
    runtime.videoStreamIndex =
      runtime.request.mediaStream?.protocol === 'dash' ? selection.index : 0
    runtime.estimatedBitrate = selection.bandwidth ?? undefined
    // FFmpeg muxing is restarted from the beginning; a segmented media download cannot safely resume at arbitrary output-file offsets.
    await rm(runtime.tempPath, { force: true }).catch(() => {})
    runtime.state.bytesDownloaded = 0
    runtime.state.totalBytes = 0
    runtime.state.status = 'queued'
    runtime.state.queuedAt = Date.now()
    await this.persist(runtime)
    this.pushUpdate(runtime)
  }

  async cancel(id: string): Promise<void> {
    await this.initialization
    const runtime = this.runtimes.get(id)
    if (!runtime || !['downloading', 'paused', 'error', 'queued'].includes(runtime.state.status))
      throw new Error('Media download cannot be cancelled.')
    if (runtime.child) {
      runtime.intentionalStop = 'cancel'
      runtime.child.kill()
      return
    }
    await rm(runtime.tempPath, { force: true }).catch(() => {})
    runtime.state.status = 'cancelled'
    runtime.state.bytesDownloaded = 0
    runtime.state.speedBytesPerSec = 0
    await this.removeManifest(id)
    this.pushUpdate(runtime)
  }

  async remove(id: string, trashFile = false): Promise<void> {
    await this.initialization
    const runtime = this.runtimes.get(id)
    if (runtime?.child) await this.cancel(id)
    if (runtime) {
      runtime.removed = true
      clearInterval(runtime.timer)
      await rm(runtime.tempPath, { force: true }).catch(() => {})
      await this.removeManifest(id)
      if (trashFile && runtime.state.status === 'completed')
        await shell.trashItem(runtime.state.destinationPath)
      this.runtimes.delete(id)
    }
    await removeFromHistory([id])
    this.getWindow()?.webContents.send(IpcChannels.historyChanged)
  }

  async open(id: string): Promise<boolean> {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.state.status !== 'completed') return false
    return (await shell.openPath(runtime.state.destinationPath)).length === 0
  }

  reveal(id: string): boolean {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.state.status !== 'completed') return false
    shell.showItemInFolder(runtime.state.destinationPath)
    return true
  }

  private toUpdate(runtime: MediaRuntime): HttpDownloadUpdate {
    const { blocks, ...state } = runtime.state
    void blocks
    return { seq: ++runtime.sequence, state, blocks: [] }
  }

  private pushUpdate(runtime: MediaRuntime): void {
    if (runtime.removed) return
    const update = this.toUpdate(runtime)
    this.getWindow()?.webContents.send(IpcChannels.downloadUpdated, update)
  }
}
