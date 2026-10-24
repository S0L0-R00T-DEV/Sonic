import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createServer as createNetServer, type Socket } from 'node:net'
import { readFile } from 'node:fs/promises'
import { expect, test, BLOCK } from './fixtures'
import { parseMetalinkManifest } from '../src/main/download/metalink'
import { parseFtpResource } from '../src/main/download/ftpProtocol'

const metalink = (content: string): string =>
  '<metalink xmlns="urn:ietf:params:xml:ns:metalink"><file name="archive.zip">' +
  content +
  '</file></metalink>'

async function serveFtp(payload: Buffer): Promise<{ url: string; close: () => Promise<void> }> {
  let passiveServer: ReturnType<typeof createNetServer> | null = null
  const passiveServers = new Set<ReturnType<typeof createNetServer>>()
  const controls = new Set<Socket>()
  const server = createNetServer((control) => {
    controls.add(control)
    control.on('error', () => {})
    control.write('220 Sonic test FTP ready\r\n')
    let buffered = ''
    let dataSocket: Socket | null = null
    let restartAt = 0
    let transferStarted = false
    control.on('close', () => controls.delete(control))
    control.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      const lines = buffered.split(/\r?\n/)
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        const split = line.indexOf(' ')
        const command = (split < 0 ? line : line.slice(0, split)).toUpperCase()
        const argument = split < 0 ? '' : line.slice(split + 1)
        if (command === 'USER') control.write('331 Password required\r\n')
        else if (command === 'PASS') control.write('230 Logged in\r\n')
        else if (command === 'FEAT')
          control.write('211-Features\r\n SIZE\r\n MDTM\r\n EPSV\r\n REST STREAM\r\n211 End\r\n')
        else if (command === 'OPTS' || command === 'TYPE' || command === 'NOOP')
          control.write('200 OK\r\n')
        else if (command === 'PWD') control.write('257 "/" is current directory\r\n')
        else if (command === 'SIZE') control.write(`213 ${payload.length}\r\n`)
        else if (command === 'MDTM') control.write('213 20261023120000\r\n')
        else if (command === 'REST') {
          restartAt = Number(argument) || 0
          control.write('350 Restart accepted\r\n')
        } else if (command === 'EPSV' || command === 'PASV') {
          passiveServer?.close()
          passiveServer = createNetServer((socket) => {
            dataSocket = socket
            socket.on('error', () => {})
            socket.on('close', () => {
              if (transferStarted && !control.destroyed) control.write('226 Transfer complete\r\n')
              transferStarted = false
            })
          })
          passiveServers.add(passiveServer)
          passiveServer.listen(0, '127.0.0.1', () => {
            const address = passiveServer?.address()
            if (!address || typeof address === 'string') return
            if (command === 'EPSV')
              control.write(`229 Entering Extended Passive Mode (|||${address.port}|)\r\n`)
            else
              control.write(
                `227 Entering Passive Mode (127,0,0,1,${Math.floor(address.port / 256)},${address.port % 256})\r\n`
              )
          })
        } else if (command === 'RETR') {
          control.write('150 Opening data connection\r\n')
          transferStarted = true
          if (dataSocket) {
            dataSocket.end(payload.subarray(restartAt))
            dataSocket = null
          }
          restartAt = 0
        } else if (command === 'ABOR') control.write('226 Abort successful\r\n')
        else if (command === 'QUIT') control.write('221 Bye\r\n')
        else control.write('200 OK\r\n')
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('FTP fixture failed to bind')
  return {
    url: `ftp://127.0.0.1:${address.port}/archive.bin`,
    close: async () => {
      for (const control of controls) control.destroy()
      for (const passive of passiveServers) passive.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

test('FTP and FTPS probes attempt protocol connections and report connection failures', async ({
  sonic
}) => {
  await expect(sonic.api.probeUrl('ftp://example.invalid/file.zip')).rejects.toThrow(
    /Could not inspect the FTP file/i
  )
  await expect(sonic.api.probeUrl('ftps://example.invalid/file.zip')).rejects.toThrow(
    /Could not inspect the FTP file/i
  )
})

test('FTP single-stream transfer downloads and publishes the exact payload', async ({ sonic }) => {
  const payload = Buffer.alloc(2 * BLOCK, 19)
  const expected = createHash('sha256').update(payload).digest('hex')
  const ftp = await serveFtp(payload)
  try {
    const probe = await sonic.api.probeUrl(ftp.url)
    expect(probe).toMatchObject({
      kind: 'http',
      transferProtocol: 'ftp',
      totalBytes: payload.length
    })
    const interfaces = await sonic.api.listInterfaces()
    const id = await sonic.api.startDownload({
      kind: 'http',
      url: ftp.url,
      destinationDir: sonic.dirs.dest,
      suggestedFileName: 'archive.bin',
      totalBytes: payload.length,
      supportsRanges: false,
      interfaceIds: [interfaces[0].id],
      etag: null,
      lastModified: probe.lastModified
    })
    const state = await sonic.waitForHttpStatus('completed', 15000)
    expect(state.id).toBe(id)
    expect(
      createHash('sha256')
        .update(await readFile(state.destinationPath))
        .digest('hex')
    ).toBe(expected)
  } finally {
    await ftp.close()
  }
})

test('FTP URL parsing strips secrets, rejects clear-text authentication, and validates paths', () => {
  const resource = parseFtpResource('ftps://alice:secret@example.test/releases/app.zip')
  expect(resource.safeUrl).toBe('ftps://example.test/releases/app.zip')
  expect(resource.remotePath).toBe('/releases/app.zip')
  expect(resource.credentials).toEqual({ username: 'alice', password: 'secret' })
  expect(() => parseFtpResource('ftp://alice:secret@example.test/file.zip')).toThrow(
    /without encryption/i
  )
  expect(() => parseFtpResource('ftps://example.test/directory/')).toThrow(/must identify a file/i)
  expect(() => parseFtpResource('ftps://example.test/file.zip?token=secret')).toThrow(
    /query or fragment/i
  )
})

test('Metalink URLs are parsed as manifests rather than downloaded as raw files', async ({
  sonic,
  serve
}) => {
  const origin = await serve({ size: 2 * BLOCK })
  await expect(sonic.api.probeUrl(origin.url('/package.meta4'))).rejects.toThrow(
    /well-formed XML|valid for encoding utf-8/i
  )
})

test('Metalink probing resolves the manifest to a verified direct mirror and exposes its checksum', async ({
  sonic
}) => {
  const payload = Buffer.alloc(2 * BLOCK, 7)
  const checksum = createHash('sha256').update(payload).digest('hex')
  let manifest = ''
  const server = createServer((req, res) => {
    if (req.url === '/package.meta4') {
      res.writeHead(200, {
        'content-type': 'application/metalink4+xml',
        'content-length': Buffer.byteLength(manifest)
      })
      res.end(manifest)
      return
    }
    const range = /^bytes=(\\d+)-(\\d*)$/.exec(String(req.headers.range ?? ''))
    if (!range) {
      res.writeHead(200, { 'content-length': payload.length })
      res.end(payload)
      return
    }
    const start = Number(range[1])
    const end = Math.min(range[2] ? Number(range[2]) : payload.length - 1, payload.length - 1)
    res.writeHead(206, {
      'content-type': 'application/zip',
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${payload.length}`,
      etag: '"metalink-fixture"',
      'accept-ranges': 'bytes'
    })
    res.end(payload.subarray(start, end + 1))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Test server did not bind a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  manifest = `<metalink xmlns="urn:ietf:params:xml:ns:metalink"><file name="archive.zip"><size>${payload.length}</size><hash type="sha-256">${checksum}</hash><url priority="1">${baseUrl}/archive.zip</url></file></metalink>`
  try {
    const result = await sonic.api.probeUrl(`${baseUrl}/package.meta4`)
    expect(result.kind).toBe('http')
    if (result.kind !== 'http') throw new Error('Expected a Metalink HTTP result')
    expect(result.finalUrl).toBe(`${baseUrl}/archive.zip`)
    expect(result.suggestedFileName).toBe('archive.zip')
    expect(result.totalBytes).toBe(payload.length)
    expect(result.metalink?.files[0]?.sha256).toBe(checksum)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

test('Metalink parser reads size, SHA-256 and sorts safe mirrors by priority', () => {
  const checksum = 'a'.repeat(64)
  const [file] = parseMetalinkManifest(
    metalink(
      '<size>12</size><hash type="sha-256">' +
        checksum +
        '</hash><url priority="3">https://mirror.example/archive.zip</url><url priority="1">https://primary.example/archive.zip</url>'
    )
  )
  expect(file).toMatchObject({ name: 'archive.zip', size: 12, sha256: checksum })
  expect(file.mirrors.map((mirror) => mirror.url)).toEqual([
    'https://primary.example/archive.zip',
    'https://mirror.example/archive.zip'
  ])
})

test('Metalink parser rejects entity declarations and unsafe mirror URLs', () => {
  expect(() =>
    parseMetalinkManifest(
      '<!DOCTYPE metalink [<!ENTITY x SYSTEM "file:///not-allowed">]><metalink xmlns="urn:ietf:params:xml:ns:metalink"><file name="x"><url>https://example.test/x</url></file></metalink>'
    )
  ).toThrow(/DOCTYPE or entity/i)
  expect(() => parseMetalinkManifest(metalink('<url>file:///not-allowed</url>'))).toThrow(
    /no supported, safe mirror/i
  )
  expect(() =>
    parseMetalinkManifest(metalink('<url>https://user:pass@example.test/file</url>'))
  ).toThrow(/no supported, safe mirror/i)
})
