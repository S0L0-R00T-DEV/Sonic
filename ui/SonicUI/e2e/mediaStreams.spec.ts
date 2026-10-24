import { createServer, type Server } from 'node:http'
import { test, expect } from './fixtures'

const HLS_MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,RESOLUTION=640x360,AUDIO="audio",CODECS="avc1.4d401e,mp4a.40.2"',
  '360/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="audio",CODECS="avc1.4d401f,mp4a.40.2"',
  '720/index.m3u8',
  ''
].join('\n')

async function listen(
  handler: (path: string) => { body: string; type: string; status?: number }
): Promise<{ server: Server; url: (path: string) => string }> {
  const server = createServer((request, response) => {
    const result = handler(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    response.statusCode = result.status ?? 200
    response.setHeader('Content-Type', result.type)
    response.setHeader('Content-Length', Buffer.byteLength(result.body))
    response.end(result.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Test media server did not bind to a TCP port.')
  return {
    server,
    url: (path) => `http://127.0.0.1:${address.port}${path}`
  }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
}

test.describe('on-demand media manifest detection', () => {
  test('detects HLS master playlists and exposes resolution variants', async ({ sonic }) => {
    const origin = await listen((path) => ({
      body:
        path === '/master.m3u8'
          ? HLS_MASTER
          : '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n',
      type: 'application/vnd.apple.mpegurl'
    }))
    try {
      const result = await sonic.api.probeUrl(origin.url('/master.m3u8'))
      expect(result.kind).toBe('http')
      if (result.kind !== 'http') throw new Error('Expected an HTTP/media probe result.')
      expect(result.media?.protocol).toBe('hls')
      expect(result.media?.variants.map((variant) => variant.height)).toEqual([360, 720])
      expect(result.media?.variants[1].url).toBe(origin.url('/720/index.m3u8'))
      expect(result.media?.variants[1].audioUrl).toBe(origin.url('/audio/index.m3u8'))
      expect(result.suggestedFileName).toMatch(/\.mp4$/i)
    } finally {
      await close(origin.server)
    }
  })

  test('accepts a static DASH manifest and lists video representations', async ({ sonic }) => {
    const manifest =
      '<?xml version="1.0"?><MPD type="static"><Period><AdaptationSet mimeType="video/mp4"><Representation id="low" bandwidth="400000" width="640" height="360"/><Representation id="high" bandwidth="1800000" width="1280" height="720"/></AdaptationSet><AdaptationSet mimeType="audio/mp4"><Representation id="audio" bandwidth="128000"/></AdaptationSet></Period></MPD>'
    const origin = await listen(() => ({ body: manifest, type: 'application/dash+xml' }))
    try {
      const result = await sonic.api.probeUrl(origin.url('/stream.mpd'))
      expect(result.kind).toBe('http')
      if (result.kind !== 'http') throw new Error('Expected an HTTP/media probe result.')
      expect(result.media?.protocol).toBe('dash')
      expect(result.media?.variants.map((variant) => variant.id)).toEqual(['low', 'high'])
      expect(result.media?.variants[1].height).toBe(720)
    } finally {
      await close(origin.server)
    }
  })

  test('rejects live HLS manifests instead of offering them as downloads', async ({ sonic }) => {
    const origin = await listen(() => ({
      body: '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n',
      type: 'application/vnd.apple.mpegurl'
    }))
    try {
      await expect(sonic.api.probeUrl(origin.url('/live.m3u8'))).rejects.toThrow(
        /Live HLS streams are not supported/i
      )
    } finally {
      await close(origin.server)
    }
  })

  test('rejects encrypted HLS and DRM-protected DASH', async ({ sonic }) => {
    const hls = await listen(() => ({
      body: '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n',
      type: 'application/vnd.apple.mpegurl'
    }))
    const dash = await listen(() => ({
      body: '<MPD type="static"><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:test"/><Representation id="v1" bandwidth="800000" width="640" height="360"/></AdaptationSet></Period></MPD>',
      type: 'application/dash+xml'
    }))
    try {
      await expect(sonic.api.probeUrl(hls.url('/encrypted.m3u8'))).rejects.toThrow(
        /Encrypted HLS streams are not supported/i
      )
      await expect(sonic.api.probeUrl(dash.url('/drm.mpd'))).rejects.toThrow(
        /ContentProtection is not supported/i
      )
    } finally {
      await Promise.all([close(hls.server), close(dash.server)])
    }
  })
})
