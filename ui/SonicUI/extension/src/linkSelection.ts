/** Explicit page/selection handoffs are capped to avoid unexpectedly adding huge URL lists. */
export const MAX_BATCH_URLS = 50

function supportedUrl(candidate: string, baseUrl?: string): string | null {
  const value = candidate.trim()
  if (!value || value.length > 8192) return null
  if (/^magnet:\?/i.test(value)) return value
  try {
    const url = new URL(value, baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    // Do not send embedded HTTP credentials to Sonic as part of an imported link.
    if (url.username || url.password) return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

/** Normalizes and deduplicates links collected from a page; fragments do not change file URLs. */
export function uniqueSupportedLinks(
  candidates: readonly string[],
  currentPageUrl?: string
): string[] {
  const page = currentPageUrl ? supportedUrl(currentPageUrl) : null
  const seen = new Set<string>()
  const result: string[] = []
  for (const candidate of candidates) {
    const url = supportedUrl(candidate, currentPageUrl)
    if (!url || url === page || seen.has(url)) continue
    seen.add(url)
    result.push(url)
    if (result.length >= MAX_BATCH_URLS) break
  }
  return result
}

/** Extracts explicit URLs from user-selected text, not arbitrary page text. */
export function extractSelectedLinks(text: string): string[] {
  const candidates = text.match(/(?:https?:\/\/|magnet:\?)[^\s<>"'`]+/gi) ?? []
  return uniqueSupportedLinks(
    candidates.map((candidate) => candidate.replace(/[),.;!?\]}]+$/g, ''))
  )
}
