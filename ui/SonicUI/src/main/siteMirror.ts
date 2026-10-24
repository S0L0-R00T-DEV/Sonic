import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { extname } from 'node:path'
import type { SiteMirrorPreview, SiteMirrorRequest } from '../shared/types'

const USER_AGENT = 'Speed-o-Freq-Sonic-SiteMirror/2.6'
const REQUEST_TIMEOUT_MS = 10_000
const MAX_PAGE_BYTES = 1_000_000
const MAX_LINKS = 100
const MAX_REDIRECTS = 3
const HTML_PAGE_EXTENSIONS = new Set(['', '.html', '.htm', '.php', '.asp', '.aspx'])

interface PageResponse {
  status: number
  contentType: string
  body: string
  location?: string
}
interface RobotsRule {
  allow: boolean
  path: string
}
interface RobotsGroup {
  agents: string[]
  rules: RobotsRule[]
}

function validateRequest(request: SiteMirrorRequest): { root: URL; extensions: Set<string> } {
  if (!request.termsConfirmed) {
    throw new Error(
      'Confirm that you have reviewed the website terms and have permission to mirror it.'
    )
  }
  let root: URL
  try {
    root = new URL(request.url)
  } catch {
    throw new Error('Enter a valid HTTP(S) website URL.')
  }
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password) {
    throw new Error('Site mirroring accepts HTTP(S) URLs without embedded credentials only.')
  }
  if (!Number.isInteger(request.maxDepth) || request.maxDepth < 0 || request.maxDepth > 3) {
    throw new Error('Mirror depth must be between 0 and 3.')
  }
  if (!Number.isInteger(request.maxPages) || request.maxPages < 1 || request.maxPages > 50) {
    throw new Error('Mirror page limit must be between 1 and 50.')
  }
  if (!Number.isInteger(request.delayMs) || request.delayMs < 500 || request.delayMs > 5000) {
    throw new Error('Request delay must be between 500 and 5000 milliseconds.')
  }
  if (!Array.isArray(request.extensions) || request.extensions.length > 20) {
    throw new Error('Choose no more than 20 file-type filters.')
  }
  const extensions = new Set<string>()
  for (const raw of request.extensions) {
    if (typeof raw !== 'string' || !/^\.[a-z0-9]{1,10}$/i.test(raw)) {
      throw new Error(`Invalid file-type filter: ${String(raw)}`)
    }
    extensions.add(raw.toLowerCase())
  }
  if (extensions.size === 0) throw new Error('Choose at least one file-type filter.')
  root.hash = ''
  return { root, extensions }
}

function requestPage(
  url: URL,
  maxBytes = MAX_PAGE_BYTES,
  signal?: AbortSignal
): Promise<PageResponse> {
  return new Promise((resolve, reject) => {
    const requester = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = requester(
      {
        method: 'GET',
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,text/plain;q=0.8,*/*;q=0.1',
          'Accept-Encoding': 'identity'
        }
      },
      (res) => {
        const status = res.statusCode ?? 0
        const location = typeof res.headers.location === 'string' ? res.headers.location : undefined
        const contentType =
          typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : ''
        const chunks: Buffer[] = []
        let bytes = 0
        res.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += buffer.length
          if (bytes > maxBytes) {
            req.destroy(new Error(`Page exceeded the ${maxBytes}-byte preview limit.`))
            return
          }
          chunks.push(buffer)
        })
        res.on('end', () => {
          cleanup()
          resolve({ status, contentType, body: Buffer.concat(chunks).toString('utf8'), location })
        })
        res.on('error', (error) => {
          cleanup()
          reject(error)
        })
      }
    )
    const timer = setTimeout(
      () => req.destroy(new Error('Site mirror request timed out.')),
      REQUEST_TIMEOUT_MS
    )
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      req.destroy(new Error('Site mirror preview cancelled.'))
    }
    req.on('error', (error) => {
      cleanup()
      reject(error)
    })
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    req.end()
  })
}

async function fetchSameOrigin(
  url: URL,
  origin: string,
  maxBytes = MAX_PAGE_BYTES,
  allowNotFound = false,
  signal?: AbortSignal
): Promise<PageResponse> {
  let current = new URL(url)
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (signal?.aborted) throw new Error('Site mirror preview cancelled.')
    if (
      current.origin !== origin ||
      !['http:', 'https:'].includes(current.protocol) ||
      current.username ||
      current.password
    ) {
      throw new Error('A redirect left the selected website boundary; it was blocked.')
    }
    const response = await requestPage(current, maxBytes, signal)
    if (response.status >= 300 && response.status < 400 && response.location) {
      if (redirects === MAX_REDIRECTS) throw new Error('Too many redirects during site preview.')
      current = new URL(response.location, current)
      continue
    }
    if (allowNotFound && response.status === 404) return response
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Site responded with HTTP ${response.status}.`)
    }
    return response
  }
  throw new Error('Redirect limit reached.')
}

function parseRobots(text: string): RobotsRule[] {
  const groups: RobotsGroup[] = []
  let agents: string[] = []
  let rules: RobotsRule[] = []
  let sawRule = false
  const flush = (): void => {
    if (agents.length) groups.push({ agents, rules })
    agents = []
    rules = []
    sawRule = false
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#', 1)[0].trim()
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (key === 'user-agent') {
      if (sawRule) flush()
      agents.push(value.toLowerCase())
    } else if ((key === 'allow' || key === 'disallow') && agents.length && value) {
      rules.push({ allow: key === 'allow', path: value })
      sawRule = true
    }
  }
  flush()
  const specific = groups.filter((group) =>
    group.agents.some((agent) => agent === 'speed-o-freq-sonic')
  )
  const selected = specific.length ? specific : groups.filter((group) => group.agents.includes('*'))
  return selected.flatMap((group) => group.rules)
}

function normalizeRobotsPercentEncoding(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (_sequence, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16))
    return /^[a-z0-9._~-]$/i.test(character) ? character : `%${hex.toUpperCase()}`
  })
}

function robotsRuleMatches(pathname: string, pattern: string): boolean {
  // RFC 9309: '*' matches any sequence; a terminal '$' anchors the match at the end.
  // Unreserved percent-encoded octets are decoded; reserved octets remain encoded.
  const anchored = pattern.endsWith('$')
  const source = normalizeRobotsPercentEncoding(anchored ? pattern.slice(0, -1) : pattern)
  const normalizedPathname = normalizeRobotsPercentEncoding(pathname)
  let escaped = ''
  for (const character of source) {
    if (character === '*') escaped += '.*'
    else escaped += '\\.^$+?()[]{}|'.includes(character) ? `\\${character}` : character
  }
  try {
    return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(normalizedPathname)
  } catch {
    return false
  }
}

function blockedByRobots(pathname: string, rules: RobotsRule[]): boolean {
  let best: RobotsRule | undefined
  let bestSpecificity = -1
  for (const rule of rules) {
    if (!robotsRuleMatches(pathname, rule.path)) continue
    // The most specific rule is the longest path pattern, ignoring wildcard/end-anchor syntax.
    const specificity = rule.path.replace(/[*$]/g, '').length
    if (specificity > bestSpecificity || (specificity === bestSpecificity && rule.allow)) {
      best = rule
      bestSpecificity = specificity
    }
  }
  return best ? !best.allow : false
}

function hrefsFromHtml(html: string, page: URL): URL[] {
  const result = new Map<string, URL>()
  const hrefs = [...html.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2])
  for (const raw of hrefs) {
    const href = raw.replace(/&amp;/gi, '&').trim()
    if (!href || href.startsWith('#') || /^(?:javascript|data|mailto|ftp):/i.test(href)) continue
    try {
      const url = new URL(href, page)
      if (
        url.origin !== page.origin ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        continue
      url.hash = ''
      if (!result.has(url.toString())) result.set(url.toString(), url)
    } catch {
      // Ignore malformed hrefs.
    }
  }
  return [...result.values()]
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Site mirror preview cancelled.'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new Error('Site mirror preview cancelled.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Bounded, same-origin, robots-aware dry run. It never writes files or queues downloads. */
export async function previewSiteMirror(
  request: SiteMirrorRequest,
  options: {
    signal?: AbortSignal
    onProgress?: (progress: import('../shared/types').SiteMirrorProgress) => void
  } = {}
): Promise<SiteMirrorPreview> {
  const { root, extensions } = validateRequest(request)
  const { signal, onProgress } = options
  const preview: SiteMirrorPreview = {
    startUrl: root.toString(),
    pagesVisited: 0,
    links: [],
    blockedByRobots: 0,
    issues: [],
    truncated: false,
    cancelled: false
  }
  const origin = root.origin
  let robotsRules: RobotsRule[]
  try {
    const robotsUrl = new URL('/robots.txt', origin)
    const robots = await fetchSameOrigin(robotsUrl, origin, 256_000, true, signal)
    robotsRules = robots.status === 404 ? [] : parseRobots(robots.body)
  } catch (error) {
    if (signal?.aborted) {
      preview.cancelled = true
      return preview
    }
    preview.issues.push(
      `Could not safely read robots.txt; crawl stopped fail-closed (${error instanceof Error ? error.message : String(error)}).`
    )
    return preview
  }
  if (blockedByRobots(root.pathname, robotsRules)) {
    preview.blockedByRobots++
    preview.issues.push('robots.txt disallows the starting URL; no pages were visited.')
    return preview
  }

  const queue: Array<{ url: URL; depth: number }> = [{ url: root, depth: 0 }]
  const visited = new Set<string>()
  const found = new Set<string>()
  let requests = 0
  const reportProgress = (currentPath: string): void => {
    onProgress?.({
      pagesRequested: requests,
      maxPages: request.maxPages,
      pagesVisited: preview.pagesVisited,
      candidateCount: found.size,
      blockedByRobots: preview.blockedByRobots,
      currentPath
    })
  }
  while (queue.length && requests < request.maxPages) {
    if (signal?.aborted) {
      preview.cancelled = true
      break
    }
    const item = queue.shift()!
    const key = item.url.toString()
    if (visited.has(key)) continue
    visited.add(key)
    if (blockedByRobots(item.url.pathname, robotsRules)) {
      preview.blockedByRobots++
      reportProgress(item.url.pathname)
      continue
    }
    if (requests > 0) {
      try {
        await wait(request.delayMs, signal)
      } catch (error) {
        if (signal?.aborted) {
          preview.cancelled = true
          break
        }
        throw error
      }
    }
    requests++
    reportProgress(item.url.pathname)
    try {
      const response = await fetchSameOrigin(item.url, origin, MAX_PAGE_BYTES, false, signal)
      if (/text\/html|application\/xhtml\+xml/i.test(response.contentType)) {
        preview.pagesVisited++
        for (const link of hrefsFromHtml(response.body, item.url)) {
          if (blockedByRobots(link.pathname, robotsRules)) {
            preview.blockedByRobots++
            continue
          }
          const extension = extname(link.pathname).toLowerCase()
          if (extensions.has(extension)) {
            if (found.size < MAX_LINKS) found.add(link.toString())
            else preview.truncated = true
            continue
          }
          if (
            item.depth < request.maxDepth &&
            HTML_PAGE_EXTENSIONS.has(extension) &&
            !visited.has(link.toString())
          ) {
            if (queue.length + visited.size < request.maxPages * 3)
              queue.push({ url: link, depth: item.depth + 1 })
            else preview.truncated = true
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        preview.cancelled = true
        break
      }
      preview.issues.push(
        `${item.url.pathname}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    reportProgress(item.url.pathname)
  }
  if (queue.length && !preview.cancelled) preview.truncated = true
  preview.links = [...found]
  return preview
}
