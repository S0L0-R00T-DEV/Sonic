import { basename } from 'node:path'
import { Client } from 'basic-ftp'
import type { HttpProbeResult } from '../../shared/types'

export interface FtpCredentials {
  username: string
  password: string
}

export interface ParsedFtpResource {
  url: URL
  safeUrl: string
  remotePath: string
  secure: boolean
  credentials?: FtpCredentials
  credentialsRequired: boolean
}

const FTP_TIMEOUT_MS = 15_000

function decodedPart(value: string, label: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new Error(`The FTP URL has invalid encoded ${label}.`)
  }
}

/** Parse and sanitize an FTP URL before it can be stored or shown in download state. */
export function parseFtpResource(rawUrl: string): ParsedFtpResource {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Enter a valid FTP or FTPS file URL.')
  }
  if (url.protocol !== 'ftp:' && url.protocol !== 'ftps:') {
    throw new Error('This is not an FTP or FTPS URL.')
  }
  if (!url.hostname || url.hash || url.search) {
    throw new Error('FTP URLs must name a file and must not contain a query or fragment.')
  }
  let remotePath: string
  try {
    remotePath = decodeURIComponent(url.pathname)
  } catch {
    throw new Error('The FTP URL contains an invalid encoded file path.')
  }
  if (
    !remotePath ||
    remotePath === '/' ||
    remotePath.endsWith('/') ||
    Array.from(remotePath).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f
    })
  ) {
    throw new Error(
      'The FTP URL must identify a file, not a directory or a control-character path.'
    )
  }

  const hadUser = url.username.length > 0
  const hadPassword = url.password.length > 0
  const username = decodedPart(url.username, 'username')
  const password = decodedPart(url.password, 'password')
  const credentialsRequired = (hadUser && username.toLowerCase() !== 'anonymous') || hadPassword

  if (url.protocol === 'ftp:' && credentialsRequired) {
    throw new Error(
      'FTP sends credentials without encryption. Use an ftps:// URL for authenticated downloads.'
    )
  }

  url.username = ''
  url.password = ''
  const safeUrl = url.toString()
  return {
    url,
    safeUrl,
    remotePath,
    secure: url.protocol === 'ftps:',
    credentialsRequired,
    ...(credentialsRequired ? { credentials: { username, password } } : {})
  }
}

/** The socket hook is used by basic-ftp for both the control connection and passive data sockets.
 * The passive-transfer host is additionally constrained by basic-ftp's secure default policy. */
export function bindFtpClientToLocalAddress(client: Client, localAddress: string): void {
  const ftp = client.ftp
  const originalNewSocket = ftp._newSocket.bind(ftp)
  ftp._newSocket = () => {
    const socket = originalNewSocket()
    const originalConnect = socket.connect.bind(socket)
    socket.connect = ((...args: unknown[]) => {
      const first = args[0]
      if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
        args[0] = { ...(first as Record<string, unknown>), localAddress }
      }
      return Reflect.apply(originalConnect, undefined, args) as typeof socket
    }) as typeof socket.connect
    return socket
  }
}

/** Probe file metadata only. It never downloads the payload or writes into the user's destination. */
export async function probeFtpUrl(rawUrl: string): Promise<HttpProbeResult> {
  const resource = parseFtpResource(rawUrl)
  const client = new Client(FTP_TIMEOUT_MS)
  try {
    await client.access({
      host: resource.url.hostname,
      port: resource.url.port ? Number(resource.url.port) : 21,
      user: resource.credentials?.username ?? 'anonymous',
      password: resource.credentials?.password ?? 'guest',
      secure: resource.secure
    })
    let totalBytes: number | null = null
    try {
      const size = await client.size(resource.remotePath)
      if (Number.isSafeInteger(size) && size >= 0) totalBytes = size
    } catch {
      // Some FTP servers disable SIZE. The transfer can still work, but is not safely resumable
      // across process restarts unless a usable size or modification validator is available.
    }
    let lastModified: string | null = null
    try {
      const modified = await client.lastMod(resource.remotePath)
      if (Number.isFinite(modified.getTime())) lastModified = modified.toISOString()
    } catch {
      // MDTM is optional in FTP. Missing validators remain explicit rather than being invented.
    }
    const fileName = basename(resource.remotePath)
    if (!fileName || fileName === '.' || fileName === '..') {
      throw new Error('The FTP URL does not contain a safe file name.')
    }
    return {
      kind: 'http',
      requestedUrl: resource.safeUrl,
      finalUrl: resource.safeUrl,
      transferProtocol: resource.secure ? 'ftps' : 'ftp',
      ftpCredentialsRequired: resource.credentialsRequired,
      supportsRanges: false,
      totalBytes,
      suggestedFileName: fileName,
      contentType: null,
      etag: null,
      lastModified
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not inspect the FTP file: ${detail}`)
  } finally {
    client.close()
  }
}

/** Open a fresh FTP client; FTPS uses Node's normal certificate and hostname validation. */
export async function openFtpClient(
  resource: ParsedFtpResource,
  localAddress: string,
  timeoutMs = FTP_TIMEOUT_MS
): Promise<Client> {
  const client = new Client(timeoutMs)
  bindFtpClientToLocalAddress(client, localAddress)
  try {
    await client.access({
      host: resource.url.hostname,
      port: resource.url.port ? Number(resource.url.port) : 21,
      user: resource.credentials?.username ?? 'anonymous',
      password: resource.credentials?.password ?? 'guest',
      secure: resource.secure
    })
    return client
  } catch (error) {
    client.close()
    throw error
  }
}
