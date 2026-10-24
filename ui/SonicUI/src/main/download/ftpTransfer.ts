import { open, stat } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { Client } from 'basic-ftp'
import type { HttpBlockState } from '../../shared/types'
import { parseFtpResource, openFtpClient } from './ftpProtocol'
import type { Transfer, TransferHost, HttpTransferTarget } from './transfer'
import { delay } from './transfer'

const FTP_RETRY_TIMEOUT_MS = 15_000
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const abortError = (): DOMException => new DOMException('Aborted', 'AbortError')

/**
 * FTP is a single-stream transfer: unlike HTTP range requests, FTP REST/resume is one ordered
 * stream and must be restarted from a verified offset. The existing download manager still owns
 * queueing, persistence, pause/cancel, history and publication.
 */
export class FtpTransfer implements Transfer {
  private client: Client | null = null
  private writer: ReturnType<HttpTransferTarget['file']['writer']> | null = null
  private ended: Promise<void> | null = null

  constructor(
    private readonly runtime: HttpTransferTarget,
    private readonly host: TransferHost,
    private readonly localAddress: string
  ) {}

  reconcile(): void {
    if (
      this.ended ||
      this.runtime.state.status !== 'downloading' ||
      this.runtime.stop.signal.aborted ||
      !this.runtime.blocks.some((block) => block.status !== 'completed')
    ) {
      return
    }
    const selected = this.runtime.state.networks.find(
      (network) => network.enabled && network.status === 'on'
    )
    if (!selected) return
    this.ended = this.download(selected.id).finally(() => {
      this.client?.close()
      this.client = null
      this.writer = null
      this.ended = null
    })
  }

  tick(): void {
    this.host.reconcile()
  }

  running(): Iterable<Promise<void>> {
    return this.ended ? [this.ended] : []
  }

  abort(): void {
    this.client?.close()
    this.client = null
    this.writer?.destroy()
    this.writer = null
  }

  reset(): void {
    this.abort()
    this.ended = null
    for (const block of this.runtime.blocks) {
      if (block.status === 'downloading') block.status = 'pending'
    }
    for (const stream of this.runtime.state.streams) {
      if (stream.status !== 'completed') stream.status = 'pending'
      stream.speedBytesPerSec = 0
    }
  }

  wake(): void {
    this.host.reconcile()
  }

  systemResumed(): void {
    this.host.reconcile()
  }

  private async download(networkId: string): Promise<void> {
    const { state, requestPayload, file, blocks, stop } = this.runtime
    const block = blocks[0] as HttpBlockState | undefined
    const network = state.networks.find((entry) => entry.id === networkId)
    if (!block || !network || stop.signal.aborted || state.status !== 'downloading') return

    const signal = stop.signal
    let resource: ReturnType<typeof parseFtpResource>
    let client: Client | null = null
    let sink: Writable | null = null
    const offset = block.bytesDownloaded
    const streamId = 1

    try {
      if (requestPayload.ftpCredentialsRequired && !requestPayload.ftpCredentials) {
        throw new Error(
          'This FTP download needs credentials that could not be stored securely. Start a new download with its FTPS link and credentials.'
        )
      }
      resource = parseFtpResource(requestPayload.url)
      if (requestPayload.ftpCredentials) {
        resource = {
          ...resource,
          credentials: requestPayload.ftpCredentials,
          credentialsRequired: true
        }
      }
      client = await openFtpClient(resource, this.localAddress, FTP_RETRY_TIMEOUT_MS)
      this.client = client
      if (signal.aborted || state.status !== 'downloading') return

      let remoteSize: number | null = null
      try {
        const size = await client.size(resource.remotePath)
        if (Number.isSafeInteger(size) && size >= 0) remoteSize = size
      } catch {
        // SIZE isn't supported by every FTP server; the stream is still usable as a new download.
      }
      let remoteModified: string | null = null
      try {
        const modified = await client.lastMod(resource.remotePath)
        if (Number.isFinite(modified.getTime())) remoteModified = modified.toISOString()
      } catch {
        // MDTM is optional. Absence is significant when deciding whether a partial file can resume.
      }

      if (state.totalBytes > 0 && remoteSize !== null && state.totalBytes !== remoteSize) {
        throw Object.assign(
          new Error('The FTP file size changed since it was checked. Start the download again.'),
          {
            discard: true
          }
        )
      }
      if (
        requestPayload.lastModified &&
        remoteModified &&
        Date.parse(requestPayload.lastModified) !== Date.parse(remoteModified)
      ) {
        throw Object.assign(
          new Error('The FTP file was modified after it was checked. Start the download again.'),
          {
            discard: true
          }
        )
      }
      if (offset > 0 && (!remoteModified || !requestPayload.lastModified)) {
        throw Object.assign(
          new Error(
            'This FTP server does not provide a current modification-time validator, so resuming safely is impossible. Start the download again.'
          ),
          { discard: true }
        )
      }
      if (state.totalBytes <= 0 && remoteSize !== null) {
        state.totalBytes = remoteSize
        requestPayload.totalBytes = remoteSize
        block.rangeEnd = remoteSize > 0 ? remoteSize - 1 : null
      }
      if (remoteSize !== null && state.totalBytes > 0 && remoteSize !== state.totalBytes) {
        throw Object.assign(
          new Error('The FTP file size is inconsistent. Start the download again.'),
          {
            discard: true
          }
        )
      }

      const handle = await open(file.path, 'r+')
      try {
        const currentSize = (await handle.stat()).size
        if (offset > currentSize) {
          throw Object.assign(
            new Error(
              'The FTP partial file is shorter than its saved progress. Start the download again.'
            ),
            { discard: true }
          )
        }
        // A crash may leave bytes written after the last persisted progress checkpoint. Never
        // retain an unaccounted tail: REST resumes at the saved offset and must overwrite from it.
        await handle.truncate(offset)
      } finally {
        await handle.close()
      }

      const output = file.writer(offset)
      this.writer = output
      block.interfaceId = networkId
      block.status = 'downloading'
      const existingStream = state.streams.find((entry) => entry.id === streamId)
      const stream = existingStream ?? {
        id: streamId,
        interfaceId: networkId,
        rangeStart: offset,
        rangeEnd: state.totalBytes > 0 ? state.totalBytes - 1 : null,
        bytesDownloaded: offset,
        speedBytesPerSec: 0,
        status: 'downloading' as const,
        currentBlockIndex: block.index
      }
      Object.assign(stream, {
        interfaceId: networkId,
        rangeStart: offset,
        rangeEnd: state.totalBytes > 0 ? state.totalBytes - 1 : null,
        bytesDownloaded: offset,
        status: 'downloading',
        currentBlockIndex: block.index
      })
      if (!existingStream) state.streams.push(stream)

      sink = new Writable({
        write: (chunk: Buffer | string, encoding, callback) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
          void (async () => {
            const waitMs = this.host.limits.take(
              networkId,
              bytes.length,
              state.id,
              state.maxDownloadSpeedBytesPerSecond
            )
            if (waitMs > 0) await delay(waitMs, signal)
            if (signal.aborted || state.status !== 'downloading') throw abortError()
            await new Promise<void>((resolve, reject) => {
              output.write(bytes, (error) => (error ? reject(error) : resolve()))
            })
            block.bytesDownloaded += bytes.length
            block.bytesByInterface[networkId] =
              (block.bytesByInterface[networkId] ?? 0) + bytes.length
            stream.bytesDownloaded = block.bytesDownloaded
            stream.interfaceId = networkId
            network.bytesDownloaded += bytes.length
            this.runtime.meters.add(streamId, networkId, bytes.length)
            state.bytesDownloaded = blocks.reduce((sum, item) => sum + item.bytesDownloaded, 0)
            this.host.scheduleUpdate()
          })().then(
            () => callback(),
            (error: unknown) => callback(error as Error)
          )
        }
      })

      await client.downloadTo(sink, resource.remotePath, offset)
      sink.end()
      await finished(sink)
      output.end()
      await finished(output)
      await file.sync()
      if (signal.aborted || state.status !== 'downloading') return

      const finalSize = await stat(file.path).then((info) => info.size)
      if (state.totalBytes > 0 && block.bytesDownloaded !== state.totalBytes) {
        throw new Error(
          `FTP transfer ended early: received ${block.bytesDownloaded} of ${state.totalBytes} bytes.`
        )
      }
      if (state.totalBytes > 0 && finalSize < state.totalBytes) {
        throw new Error('The FTP output file is incomplete.')
      }
      block.status = 'completed'
      stream.status = 'completed'
      stream.currentBlockIndex = undefined
      stream.speedBytesPerSec = 0
      network.status = 'on'
      network.error = undefined
      this.host.scheduleUpdate()
    } catch (error) {
      if (signal.aborted || state.status !== 'downloading') return
      const detail = message(error)
      if (!this.client?.closed) this.client?.close()
      network.status = /ECONN|EHOST|ENET|ETIMEDOUT|timeout|socket|passive mode/i.test(detail)
        ? 'unreachable'
        : 'failed'
      network.error = detail
      this.host.failDownload(detail, Boolean((error as { discard?: boolean } | null)?.discard))
    } finally {
      sink?.destroy()
      this.writer?.destroy()
      this.writer = null
      this.client?.close()
      this.client = null
    }
  }
}
