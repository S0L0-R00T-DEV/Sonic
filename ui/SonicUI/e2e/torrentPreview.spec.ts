import { Readable } from 'node:stream'
import { expect, test } from './fixtures'
import { TorrentPreviewServer } from '../src/main/download/torrentPreview'

test('torrent preview bridge is loopback-only and supports byte ranges', async () => {
  const bytes = Buffer.from('0123456789abcdef')
  const preview = new TorrentPreviewServer(() => ({
    size: bytes.length,
    contentType: 'video/mp4',
    stream: (start, end) => Readable.from([bytes.subarray(start, end + 1)])
  }))
  const url = await preview.open('task-id', 0)

  const ranged = await fetch(url, { headers: { Range: 'bytes=2-5' } })
  expect(ranged.status).toBe(206)
  expect(ranged.headers.get('content-range')).toBe('bytes 2-5/16')
  expect(ranged.headers.get('content-type')).toContain('video/mp4')
  expect(Buffer.from(await ranged.arrayBuffer())).toEqual(Buffer.from('2345'))

  const invalid = await fetch(url, { headers: { Range: 'bytes=100-200' } })
  expect(invalid.status).toBe(416)
  expect(invalid.headers.get('content-range')).toBe('bytes */16')

  const method = await fetch(url, { method: 'POST' })
  expect(method.status).toBe(405)
})
