import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, rename, rm, stat, statfs } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { basename, extname, join, parse } from 'node:path'
import type { BrowserWindow } from 'electron'
import type {
  MediaConversionFormat,
  MediaConversionOptions,
  MediaConversionProgress
} from '../../shared/types'
import { IpcChannels } from '../../shared/ipc-channels'
import { findInHistory } from './history'
import { reserveDestinationPath } from './paths'

const FORMATS = new Set<MediaConversionFormat>(['mp4', 'mkv', 'webm', 'mp3', 'wav', 'ogg', 'flac'])
const INPUT_FORMATS: Record<string, string> = {
  '.mp4': 'mov',
  '.m4v': 'mov',
  '.mov': 'mov',
  '.m4a': 'mov',
  '.3gp': 'mov',
  '.mkv': 'matroska',
  '.webm': 'matroska',
  '.avi': 'avi',
  '.flv': 'flv',
  '.ts': 'mpegts',
  '.mpg': 'mpeg',
  '.mpeg': 'mpeg',
  '.mp3': 'mp3',
  '.aac': 'aac',
  '.wav': 'wav',
  '.ogg': 'ogg',
  '.oga': 'ogg',
  '.opus': 'ogg',
  '.flac': 'flac'
}
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac'])

type Job = {
  child: ChildProcess
  tempPath: string
  outputPath: string
  cancelled: boolean
  settled: boolean
  done: Promise<void>
  resolveDone: () => void
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk: string | Buffer) =>
      hash.update(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    )
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return hash.digest('hex')
}

export class MediaConversionManager {
  private readonly jobs = new Map<string, Job>()
  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  private emit(progress: MediaConversionProgress): void {
    const window = this.getWindow()
    if (window && !window.isDestroyed())
      window.webContents.send(IpcChannels.mediaConversionProgress, progress)
  }

  async start(downloadId: string, options: MediaConversionOptions): Promise<string> {
    if (!options || typeof options !== 'object') throw new Error('Conversion options are missing.')
    if (!FORMATS.has(options.format)) throw new Error('Choose a supported output format.')
    if (
      typeof options.ffmpegPath !== 'string' ||
      !options.ffmpegPath ||
      !options.expectedSha256 ||
      !/^[a-f0-9]{64}$/i.test(options.expectedSha256)
    ) {
      throw new Error('Choose FFmpeg and enter the trusted SHA-256 checksum from its distributor.')
    }
    if (!isAbsolutePath(options.ffmpegPath) || !isAbsolutePath(options.outputDir))
      throw new Error('FFmpeg and output folder must be absolute paths.')
    const executable = await lstat(options.ffmpegPath).catch(() => null)
    if (!executable?.isFile() || executable.isSymbolicLink())
      throw new Error('The selected FFmpeg executable must be a regular, non-symlink file.')
    const actualHash = await sha256File(options.ffmpegPath)
    if (actualHash.toLowerCase() !== options.expectedSha256.toLowerCase())
      throw new Error(
        'FFmpeg SHA-256 does not match the trusted checksum you entered. Conversion was not started.'
      )

    const entry = await findInHistory(downloadId)
    if (!entry || entry.kind !== 'http' || entry.missing)
      throw new Error('Conversion requires a completed, present HTTP media file.')
    const sourceInfo = await lstat(entry.destinationPath).catch(() => null)
    if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink())
      throw new Error('The completed source must be a regular file, not a folder or symbolic link.')
    const sourceExt = extname(entry.destinationPath).toLowerCase()
    const inputFormat = INPUT_FORMATS[sourceExt]
    if (!inputFormat) throw new Error('This source format is not supported for conversion.')
    const outputExt = `.${options.format}`
    if (
      AUDIO_EXTENSIONS.has(sourceExt) &&
      ['mp4', 'mkv', 'webm'].includes(options.format) &&
      sourceExt === '.flac'
    ) {
      // Audio-only FLAC can be muxed into these containers, but it is still treated as audio below.
    }
    if (
      !AUDIO_EXTENSIONS.has(sourceExt) &&
      ['mp3', 'wav', 'ogg', 'flac'].includes(options.format)
    ) {
      // Audio targets are permitted for video sources only when an audio stream exists; FFmpeg reports otherwise.
    }
    const directory = await stat(options.outputDir).catch(() => null)
    if (!directory?.isDirectory()) throw new Error('Choose an existing output folder.')
    const space = await statfs(options.outputDir)
    const freeBytes = space.bavail * space.bsize
    const minimumFree = Math.max(
      64 * 1024 * 1024,
      sourceInfo.size + Math.ceil(sourceInfo.size * 0.25)
    )
    if (freeBytes < minimumFree)
      throw new Error(
        `Not enough free space. At least ${Math.ceil(minimumFree / (1024 * 1024))} MiB is required.`
      )

    const sourceName = basename(entry.destinationPath, extname(entry.destinationPath))
    const outputPath = await reserveDestinationPath(options.outputDir, `${sourceName}${outputExt}`)
    const tempPath = join(
      options.outputDir,
      `.${parse(outputPath).name}.${randomUUID()}.partial${outputExt}`
    )
    const operationId = randomUUID()
    const args = this.args(options.format, inputFormat, entry.destinationPath, tempPath)
    let child: ChildProcess
    const finalHash = await sha256File(options.ffmpegPath).catch(() => '')
    if (finalHash.toLowerCase() !== options.expectedSha256.toLowerCase()) {
      await rm(`${outputPath}.sonic`, { force: true }).catch(() => {})
      throw new Error('FFmpeg changed after verification. Conversion was not started.')
    }
    try {
      child = spawn(options.ffmpegPath, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      })
    } catch (error) {
      await rm(`${outputPath}.sonic`, { force: true }).catch(() => {})
      throw error
    }
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const job: Job = {
      child,
      tempPath,
      outputPath,
      cancelled: false,
      settled: false,
      done,
      resolveDone
    }
    this.jobs.set(operationId, job)
    this.emit({ operationId, downloadId, status: 'running', outputPath })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-5000)
    })
    const settle = async (code: number | null, error?: Error): Promise<void> => {
      if (job.settled) return
      job.settled = true
      try {
        if (job.cancelled) {
          await rm(tempPath, { force: true }).catch(() => {})
          await rm(`${outputPath}.sonic`, { force: true }).catch(() => {})
          this.emit({
            operationId,
            downloadId,
            status: 'cancelled',
            message: 'Conversion cancelled; temporary output removed.'
          })
          return
        }
        if (error || code !== 0)
          throw error ?? new Error(stderr.trim() || `FFmpeg exited with code ${String(code)}.`)
        const output = await lstat(tempPath).catch(() => null)
        if (!output?.isFile() || output.size <= 0)
          throw new Error('FFmpeg finished without producing a non-empty output file.')
        if (
          await lstat(outputPath).then(
            () => true,
            () => false
          )
        )
          throw new Error('Output path was claimed by another process; refusing to overwrite it.')
        await rename(tempPath, outputPath)
        await rm(`${outputPath}.sonic`, { force: true }).catch(() => {})
        this.emit({ operationId, downloadId, status: 'completed', outputPath })
      } catch (cause) {
        await rm(tempPath, { force: true }).catch(() => {})
        await rm(`${outputPath}.sonic`, { force: true }).catch(() => {})
        this.emit({
          operationId,
          downloadId,
          status: 'error',
          message: cause instanceof Error ? cause.message : String(cause)
        })
      } finally {
        this.jobs.delete(operationId)
        job.resolveDone()
      }
    }
    child.once('error', (error) => {
      void settle(null, error)
    })
    child.once('close', (code) => {
      void settle(code)
    })
    return operationId
  }

  cancel(operationId: string): void {
    const job = this.jobs.get(operationId)
    if (!job || job.settled) return
    job.cancelled = true
    job.child.kill()
  }

  async cancelAll(): Promise<void> {
    const jobs = [...this.jobs.values()]
    for (const job of jobs) {
      if (job.settled) continue
      job.cancelled = true
      job.child.kill()
    }
    await Promise.all(jobs.map((job) => job.done))
  }

  private args(
    format: MediaConversionFormat,
    inputFormat: string,
    source: string,
    output: string
  ): string[] {
    const base = [
      '-hide_banner',
      '-nostdin',
      '-n',
      '-loglevel',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-f',
      inputFormat,
      '-i',
      source,
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1'
    ]
    if (format === 'mp4')
      return [
        ...base,
        '-map',
        '0:v:0?',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        output
      ]
    if (format === 'mkv')
      return [
        ...base,
        '-map',
        '0:v:0?',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-f',
        'matroska',
        output
      ]
    if (format === 'webm')
      return [
        ...base,
        '-map',
        '0:v:0?',
        '-map',
        '0:a:0?',
        '-c:v',
        'libvpx-vp9',
        '-crf',
        '32',
        '-b:v',
        '0',
        '-c:a',
        'libopus',
        '-b:a',
        '128k',
        '-f',
        'webm',
        output
      ]
    if (format === 'mp3')
      return [
        ...base,
        '-map',
        '0:a:0',
        '-vn',
        '-c:a',
        'libmp3lame',
        '-q:a',
        '2',
        '-f',
        'mp3',
        output
      ]
    if (format === 'wav')
      return [...base, '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', '-f', 'wav', output]
    if (format === 'ogg')
      return [
        ...base,
        '-map',
        '0:a:0',
        '-vn',
        '-c:a',
        'libvorbis',
        '-q:a',
        '5',
        '-f',
        'ogg',
        output
      ]
    return [...base, '-map', '0:a:0', '-vn', '-c:a', 'flac', '-f', 'flac', output]
  }
}

function isAbsolutePath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\') || path.startsWith('/')
}
