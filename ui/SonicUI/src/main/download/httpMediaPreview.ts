import { randomBytes } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'

export type HttpMediaPreviewSource = {
  path: string
  totalBytes: number
  /** Bytes in the contiguous prefix proven written by the downloader (never sparse-file holes). */
  availableBytes: number
  status: 'downloading' | 'paused' | 'queued' | 'completed' | 'error' | 'cancelled'
  contentType: string
}
type PreviewEntry = { downloadId: string; expiresAt: number }
type PreviewProvider = (downloadId: string) => HttpMediaPreviewSource
const PREVIEW_TTL_MS = 30 * 60 * 1000
const MAX_PREVIEW_TOKENS = 8
const CHUNK_BYTES = 256 * 1024

/** Loopback-only progressive HTTP stream for a single sequential HTTP media download. */
export class HttpMediaPreviewServer {
  private server: Server | null = null
  private readonly entries = new Map<string, PreviewEntry>()
  constructor(private readonly provide: PreviewProvider) {}

  async open(downloadId: string): Promise<string> {
    this.provide(downloadId)
    const token = randomBytes(32).toString('base64url')
    this.entries.set(token, { downloadId, expiresAt: Date.now() + PREVIEW_TTL_MS })
    while (this.entries.size > MAX_PREVIEW_TOKENS) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (!oldest) break
      this.entries.delete(oldest)
    }
    const server = await this.ensureServer()
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/${token}`
  }

  async close(): Promise<void> {
    this.entries.clear()
    const server = this.server
    this.server = null
    if (!server?.listening) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private ensureServer(): Promise<Server> {
    if (this.server?.listening) return Promise.resolve(this.server)
    if (this.server)
      return new Promise((resolve, reject) => {
        this.server!.once('listening', () => resolve(this.server!))
        this.server!.once('error', reject)
      })
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, { 'Cache-Control': 'no-store' })
        response.destroy()
      })
    })
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', (error) => {
        this.server = null
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => {
        server.unref()
        resolve(server)
      })
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1)
    const entry = this.entries.get(token)
    if (!entry || entry.expiresAt <= Date.now()) {
      this.entries.delete(token)
      response.writeHead(404, { 'Cache-Control': 'no-store' }).end()
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }).end()
      return
    }
    const source = this.provide(entry.downloadId)
    const diskSize = await stat(source.path).then(
      (s) => s.size,
      () => 0
    )
    const availableSize = Math.min(diskSize, Math.max(0, source.availableBytes))
    const totalKnown = Number.isSafeInteger(source.totalBytes) && source.totalBytes > 0
    const total = totalKnown ? source.totalBytes : availableSize
    let start = 0
    let end = totalKnown ? total - 1 : Number.MAX_SAFE_INTEGER
    let status = 200
    const range = request.headers.range
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
      if (!match || (!match[1] && !match[2]) || !totalKnown) {
        response
          .writeHead(416, { 'Cache-Control': 'no-store', 'Content-Range': `bytes */${total}` })
          .end()
        return
      }
      if (!match[1]) {
        const suffix = Number(match[2])
        if (!Number.isSafeInteger(suffix) || suffix <= 0) {
          response
            .writeHead(416, { 'Cache-Control': 'no-store', 'Content-Range': `bytes */${total}` })
            .end()
          return
        }
        start = Math.max(0, total - suffix)
      } else {
        start = Number(match[1])
        end = match[2] ? Number(match[2]) : total - 1
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start >= total ||
        end < start
      ) {
        response
          .writeHead(416, { 'Cache-Control': 'no-store', 'Content-Range': `bytes */${total}` })
          .end()
        return
      }
      end = Math.min(end, total - 1)
      status = 206
    }
    const length = totalKnown ? Math.max(0, end - start + 1) : undefined
    response.writeHead(status, {
      'Accept-Ranges': totalKnown ? 'bytes' : 'none',
      'Cache-Control': 'no-store',
      'Content-Type': source.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...(length !== undefined ? { 'Content-Length': String(length) } : {}),
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {})
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    const aborted = (): void => {
      response.destroy()
    }
    request.once('aborted', aborted)
    response.once('close', () => request.removeListener('aborted', aborted))
    const stream = Readable.from(
      this.readGrowingFile(entry.downloadId, source, start, end, totalKnown)
    )
    response.once('close', () => stream.destroy())
    stream.on('error', () => response.destroy())
    stream.pipe(response)
  }

  private async *readGrowingFile(
    id: string,
    initial: HttpMediaPreviewSource,
    start: number,
    end: number,
    totalKnown: boolean
  ): AsyncGenerator<Buffer> {
    let offset = start
    while (offset <= end) {
      let source: HttpMediaPreviewSource
      try {
        source = this.provide(id)
      } catch {
        return
      }
      const diskSize = await stat(source.path).then(
        (s) => s.size,
        () => 0
      )
      const size = Math.min(diskSize, Math.max(0, source.availableBytes))
      if (offset < size) {
        const length = Math.min(CHUNK_BYTES, size - offset, end - offset + 1)
        const handle = await open(source.path, 'r')
        try {
          const buffer = Buffer.allocUnsafe(length)
          const { bytesRead } = await handle.read(buffer, 0, length, offset)
          if (bytesRead > 0) {
            offset += bytesRead
            yield buffer.subarray(0, bytesRead)
            continue
          }
        } finally {
          await handle.close()
        }
      }
      if (source.status !== 'downloading') return
      if (totalKnown && offset >= initial.totalBytes) return
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
}
