import { URL } from 'node:url'

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5
const MANIFEST_TIMEOUT_MS = 10_000
const MAX_VARIANTS = 100

export type MediaProtocol = 'hls' | 'dash'

import type { MediaStreamInfo, MediaVariant } from '../../shared/types'

export type { MediaStreamInfo, MediaVariant }

function assertWebUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Media manifest URL is invalid.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(
      'Media manifests and segments must use HTTP(S) URLs without embedded credentials.'
    )
  }
  return url
}

async function fetchManifest(
  rawUrl: string
): Promise<{ url: URL; contentType: string; body: string }> {
  let url = assertWebUrl(rawUrl)
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
      headers: {
        Accept:
          'application/vnd.apple.mpegurl, application/x-mpegURL, application/dash+xml, text/plain, application/xml;q=0.9, */*;q=0.1'
      }
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('Media manifest redirect did not include a destination.')
      if (redirect === MAX_REDIRECTS)
        throw new Error('Too many redirects while checking the media manifest.')
      url = assertWebUrl(new URL(location, url).toString())
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Media manifest server responded with status ${response.status}.`)
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (contentLength > MAX_MANIFEST_BYTES) {
      await response.body?.cancel()
      throw new Error('Media manifest exceeds the 2 MiB safety limit.')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Media manifest response has no body.')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_MANIFEST_BYTES) {
          await reader.cancel()
          throw new Error('Media manifest exceeds the 2 MiB safety limit.')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const body = new TextDecoder('utf-8', { fatal: false }).decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    )
    return { url, contentType: response.headers.get('content-type') ?? '', body }
  }
  throw new Error('Too many redirects while checking the media manifest.')
}

function attributeList(input: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi
  for (const match of input.matchAll(pattern)) {
    attributes[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '').trim()
  }
  return attributes
}

function resolution(value: string | undefined): { width: number | null; height: number | null } {
  const match = value && /^(\d{1,5})x(\d{1,5})$/i.exec(value)
  if (!match) return { width: null, height: null }
  const width = Number(match[1])
  const height = Number(match[2])
  if (width < 1 || height < 1 || width > 16384 || height > 16384) {
    return { width: null, height: null }
  }
  return { width, height }
}

function variantLabel(height: number | null, bandwidth: number | null, id: string): string {
  const dimensions = height ? `${height}p` : null
  const rate = bandwidth
    ? `${(bandwidth / 1_000_000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} Mbps`
    : null
  return [dimensions, rate, id].filter(Boolean).join(' · ')
}

function parseHls(body: string, manifestUrl: URL): MediaStreamInfo {
  if (!/^\s*#EXTM3U(?:\r?\n|\s*$)/i.test(body))
    throw new Error('The URL is not a valid HLS playlist.')
  if (
    /#EXT-X-KEY\s*:\s*METHOD\s*=(?!\s*NONE\b)/i.test(body) ||
    /#EXT-X-SESSION-KEY\s*:/i.test(body)
  ) {
    throw new Error(
      'Encrypted HLS streams are not supported. DRM and encrypted media are not downloaded.'
    )
  }
  if (/#EXT-X-ENDLIST\b/i.test(body) === false && !/#EXT-X-STREAM-INF\s*:/i.test(body)) {
    throw new Error('Live HLS streams are not supported; provide an on-demand playlist.')
  }
  const lines = body.split(/\r?\n/).map((line) => line.trim())
  const audioGroups = new Map<string, string | null>()
  for (const line of lines) {
    if (!line.toUpperCase().startsWith('#EXT-X-MEDIA:')) continue
    const attrs = attributeList(line.slice(line.indexOf(':') + 1))
    if (attrs['TYPE'] !== 'AUDIO' || !attrs['GROUP-ID']) continue
    const audioUrl = attrs['URI']
      ? assertWebUrl(new URL(attrs['URI'], manifestUrl).toString()).toString()
      : null
    audioGroups.set(attrs['GROUP-ID'], audioUrl)
  }

  const variants: MediaVariant[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.toUpperCase().startsWith('#EXT-X-STREAM-INF:')) continue
    const attrs = attributeList(line.slice(line.indexOf(':') + 1))
    let next = index + 1
    while (next < lines.length && (!lines[next] || lines[next].startsWith('#'))) next += 1
    if (next >= lines.length) throw new Error('HLS variant is missing its playlist URL.')
    const target = assertWebUrl(new URL(lines[next], manifestUrl).toString())
    const dims = resolution(attrs['RESOLUTION'])
    const bandwidth = Number(attrs['AVERAGE-BANDWIDTH'] ?? attrs['BANDWIDTH'])
    const safeBandwidth = Number.isSafeInteger(bandwidth) && bandwidth > 0 ? bandwidth : null
    const audioGroupId = attrs['AUDIO']
    if (audioGroupId && !audioGroups.has(audioGroupId)) {
      throw new Error('HLS variant references an audio group that is missing from the manifest.')
    }
    const audioUrl = audioGroupId ? (audioGroups.get(audioGroupId) ?? undefined) : undefined
    const id = `hls-${variants.length + 1}`
    variants.push({
      id,
      url: target.toString(),
      ...(audioUrl ? { audioUrl } : {}),
      label: variantLabel(dims.height, safeBandwidth, id),
      ...dims,
      bandwidth: safeBandwidth,
      codecs: attrs['CODECS'] ?? null
    })
    index = next
    if (variants.length > MAX_VARIANTS)
      throw new Error('HLS manifest has too many variants (limit: 100).')
  }
  if (variants.length === 0) {
    // A media playlist is one selectable stream. FFmpeg reads its segments and assembles the output.
    variants.push({
      id: 'hls-source',
      url: manifestUrl.toString(),
      label: 'Source playlist',
      width: null,
      height: null,
      bandwidth: null,
      codecs: null
    })
  }
  return {
    protocol: 'hls',
    manifestUrl: manifestUrl.toString(),
    variants,
    live: false,
    drm: false,
    requiresFfmpeg: true
  }
}

function parseDash(body: string, manifestUrl: URL): MediaStreamInfo {
  if (!/<MPD\b/i.test(body)) throw new Error('The URL is not a valid MPEG-DASH manifest.')
  if (/<ContentProtection\b/i.test(body))
    throw new Error(
      'DASH ContentProtection is not supported; DRM-protected media is not downloaded.'
    )
  const mpdOpen = /<MPD\b([^>]*)>/i.exec(body)
  const mpdAttrs = mpdOpen
    ? attributeList(
        mpdOpen[1].replace(/\s+([\w:-]+)=/g, (_, key: string) => `${key.toUpperCase()}=`)
      )
    : {}
  if ((mpdAttrs.TYPE ?? 'static').toLowerCase() !== 'static')
    throw new Error(
      'Live or dynamic DASH streams are not supported; provide a static on-demand manifest.'
    )

  const variants: MediaVariant[] = []
  const adaptationBlocks = body.match(/<AdaptationSet\b[^>]*>[\s\S]*?<\/AdaptationSet>/gi) ?? []
  for (const adaptation of adaptationBlocks) {
    const open = /^<AdaptationSet\b([^>]*)>/i.exec(adaptation)
    const adaptationAttrs = open ? attributeList(open[1]) : {}
    const contentType = (
      adaptationAttrs['CONTENTTYPE'] ??
      adaptationAttrs['MIMETYPE'] ??
      ''
    ).toLowerCase()
    if (contentType && contentType !== 'video' && !contentType.startsWith('video/')) continue
    const reps = adaptation.match(/<Representation\b[^>]*\/?\s*>/gi) ?? []
    for (const representation of reps) {
      const attrText = /^<Representation\b([^>]*)\/?\s*>/i.exec(representation)?.[1] ?? ''
      const attrs = attributeList(attrText)
      if (attrs['MIMETYPE'] && !attrs['MIMETYPE'].toLowerCase().startsWith('video/')) continue
      const dims = resolution(
        attrs['WIDTH'] && attrs['HEIGHT'] ? `${attrs['WIDTH']}x${attrs['HEIGHT']}` : undefined
      )
      const bandwidth = Number(attrs['BANDWIDTH'])
      const safeBandwidth = Number.isSafeInteger(bandwidth) && bandwidth > 0 ? bandwidth : null
      const id = String(attrs['ID'] ?? `dash-${variants.length + 1}`).slice(0, 64)
      variants.push({
        id,
        // The selected representation is conveyed to FFmpeg through the DASH manifest and map index.
        // Keep the manifest URL here; the renderer sends representationId separately.
        url: manifestUrl.toString(),
        label: variantLabel(dims.height, safeBandwidth, id),
        ...dims,
        bandwidth: safeBandwidth,
        codecs: attrs['CODECS'] ?? null
      })
      if (variants.length > MAX_VARIANTS)
        throw new Error('DASH manifest has too many video representations (limit: 100).')
    }
  }
  if (variants.length === 0)
    throw new Error('No supported video representations were found in the DASH manifest.')
  return {
    protocol: 'dash',
    manifestUrl: manifestUrl.toString(),
    variants,
    live: false,
    drm: false,
    requiresFfmpeg: true
  }
}

export async function inspectMediaManifest(
  rawUrl: string,
  hintedContentType = ''
): Promise<MediaStreamInfo | null> {
  const initial = assertWebUrl(rawUrl)
  const path = initial.pathname.toLowerCase()
  const looksHls = path.endsWith('.m3u8') || /mpegurl/i.test(hintedContentType)
  const looksDash = path.endsWith('.mpd') || /dash\+xml/i.test(hintedContentType)
  if (!looksHls && !looksDash) return null
  const fetched = await fetchManifest(initial.toString())
  const trimmed = fetched.body.trimStart()
  if (looksHls || /^#EXTM3U\b/i.test(trimmed) || /mpegurl/i.test(fetched.contentType)) {
    return parseHls(fetched.body, fetched.url)
  }
  if (looksDash || /<MPD\b/i.test(trimmed) || /dash\+xml/i.test(fetched.contentType)) {
    return parseDash(fetched.body, fetched.url)
  }
  return null
}
