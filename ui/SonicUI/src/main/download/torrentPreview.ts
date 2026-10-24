import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Readable } from 'node:stream'

type PreviewSource = {
  size: number
  contentType: string
  stream: (start: number, end: number) => Readable
}
type PreviewEntry = { downloadId: string; fileIndex: number; expiresAt: number }
type PreviewProvider = (downloadId: string, fileIndex: number) => PreviewSource

const PREVIEW_TTL_MS = 30 * 60 * 1000
const MAX_PREVIEW_TOKENS = 8

/** Short-lived, loopback-only HTTP byte-range bridge for a single active torrent file. */
export class TorrentPreviewServer {
  private server: Server | null = null
  private readonly entries = new Map<string, PreviewEntry>()

  constructor(private readonly provide: PreviewProvider) {}

  async open(downloadId: string, fileIndex: number): Promise<string> {
    if (!Number.isInteger(fileIndex) || fileIndex < 0)
      throw new Error('Invalid torrent file index.')
    this.provide(downloadId, fileIndex)
    const token = randomBytes(32).toString('base64url')
    this.entries.set(token, { downloadId, fileIndex, expiresAt: Date.now() + PREVIEW_TTL_MS })
    while (this.entries.size > MAX_PREVIEW_TOKENS) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (!oldest) break
      this.entries.delete(oldest)
    }
    const server = await this.ensureServer()
    const address = server.address() as AddressInfo
    return 'http://127.0.0.1:' + address.port + '/' + token
  }

  private ensureServer(): Promise<Server> {
    if (this.server?.listening) return Promise.resolve(this.server)
    if (this.server) {
      return new Promise((resolve, reject) => {
        this.server!.once('listening', () => resolve(this.server!))
        this.server!.once('error', reject)
      })
    }
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500)
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
    const source = this.provide(entry.downloadId, entry.fileIndex)
    const baseHeaders = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Type': source.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin'
    }
    let start = 0
    let end = Math.max(0, source.size - 1)
    let status = 200
    const range = request.headers.range
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
      if (!match || source.size <= 0 || (!match[1] && !match[2])) {
        response.writeHead(416, { ...baseHeaders, 'Content-Range': 'bytes */' + source.size }).end()
        return
      }
      if (!match[1]) {
        const suffix = Number(match[2])
        if (!Number.isSafeInteger(suffix) || suffix <= 0) {
          response
            .writeHead(416, { ...baseHeaders, 'Content-Range': 'bytes */' + source.size })
            .end()
          return
        }
        start = Math.max(0, source.size - suffix)
      } else {
        start = Number(match[1])
        end = match[2] ? Number(match[2]) : source.size - 1
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start >= source.size ||
        end < start
      ) {
        response.writeHead(416, { ...baseHeaders, 'Content-Range': 'bytes */' + source.size }).end()
        return
      }
      end = Math.min(end, source.size - 1)
      status = 206
    }
    const headers = {
      ...baseHeaders,
      'Content-Length': String(Math.max(0, end - start + 1)),
      ...(status === 206
        ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + source.size }
        : {})
    }
    response.writeHead(status, headers)
    if (request.method === 'HEAD' || source.size === 0) {
      response.end()
      return
    }
    const stream = source.stream(start, end)
    stream.on('error', () => response.destroy())
    response.on('close', () => stream.destroy())
    stream.pipe(response)
  }
}
