import { createServer, type Server } from 'node:net'
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { instancePipeSuffix } from './instancePipe'

type CliRequest = Record<string, unknown>
type CliDispatcher = (request: CliRequest) => Promise<unknown>

let server: Server | null = null

const pipeAddress = (): string => {
  const suffix = instancePipeSuffix()
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\SpeedOFreqSonic.AppControl.v2' + suffix
    : join(app.getPath('temp'), 'speed-of-freq-sonic-cli' + suffix + '.sock')
}

/** Local, line-delimited JSON control endpoint consumed by SpeedOFreq.Cli.exe. */
export function startCliControlServer(dispatch: CliDispatcher): void {
  if (server) return

  const endpoint = pipeAddress()
  const instance = createServer((socket) => {
    socket.setEncoding('utf8')
    // Torrent metadata lookup may need several seconds to find a peer. Keep the control pipe
    // open long enough for the CLI client to receive the command's final result.
    // Magnet metadata discovery can take up to the configured three-minute peer lookup budget.
    // Keep the IPC deadline longer than that so the client receives the actual result/error.
    socket.setTimeout(240_000)
    let input = ''
    let answered = false
    let handling = false

    const answer = (payload: unknown): void => {
      if (answered || socket.destroyed) return
      answered = true
      socket.end(JSON.stringify(payload) + '\n')
    }

    socket.on('timeout', () => {
      answer({ ok: false, error: 'CLI request timed out.' })
    })
    socket.on('error', () => {
      // Client disconnects and timeouts are isolated to that request.
    })
    socket.on('data', (chunk: string) => {
      // One command per connection. Without this guard a client could send multiple lines while
      // the first asynchronous command is still running and dispatch privileged actions twice.
      if (answered || handling) return
      input += chunk
      if (input.length > 1_000_000) {
        answer({ ok: false, error: 'CLI request exceeds the 1 MB limit.' })
        return
      }
      const newline = input.indexOf('\n')
      if (newline < 0) return

      let request: unknown
      try {
        request = JSON.parse(input.slice(0, newline))
      } catch {
        answer({ ok: false, error: 'Request must be a JSON object followed by a newline.' })
        return
      }
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        answer({ ok: false, error: 'Request must be a JSON object.' })
        return
      }

      handling = true
      void dispatch(request as CliRequest)
        .then((result) => answer({ ok: true, result }))
        .catch((error: unknown) =>
          answer({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        )
    })
  })

  // Bound idle/slow clients so a local process cannot exhaust the app with open pipe handles.
  instance.maxConnections = 32
  instance.on('error', (error) => {
    console.error('[Sonic CLI control] endpoint error:', error)
  })
  instance.listen(endpoint, () => {
    if (process.platform === 'win32') {
      // Windows named pipes inherit the creating process token's default security descriptor.
      console.info('[Sonic CLI control] ready')
      return
    }
    // Unix sockets under the temp directory must not be readable/writable by other local users.
    // Fail closed if owner-only permissions cannot be applied.
    void chmod(endpoint, 0o600)
      .then(() => console.info('[Sonic CLI control] ready'))
      .catch((error: unknown) => {
        console.error('[Sonic CLI control] could not secure the local socket; closing it', error)
        instance.close(() => {
          if (server === instance) server = null
        })
      })
  })
  server = instance
}

export function stopCliControlServer(): void {
  if (!server) return
  server.close()
  server = null
}
