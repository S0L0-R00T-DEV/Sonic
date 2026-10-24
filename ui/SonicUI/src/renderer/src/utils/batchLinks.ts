/**
 * Extract file links from a user-supplied HTML directory listing.
 * This never fetches URLs or follows links. Relative links require an explicit HTTP(S) base URL,
 * and all accepted links must remain on that exact origin. Directory links are excluded.
 */
export function directoryListingLinks(html: string, listingBaseUrl?: string): string[] {
  let base: URL | null = null
  if (listingBaseUrl?.trim()) {
    try {
      const parsed = new URL(listingBaseUrl.trim())
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        return []
      if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
      base = parsed
    } catch {
      return []
    }
  }

  const results = new Set<string>()
  const hrefs = [...html.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2])
  for (const href of hrefs) {
    const decoded = href.replace(/&amp;/gi, '&').trim()
    if (!decoded || decoded.startsWith('#') || /^(?:javascript|data|mailto|ftp):/i.test(decoded))
      continue
    try {
      const url = new URL(decoded, base ?? undefined)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
      if (base && (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))) continue
      if (!base && !/^https?:\/\//i.test(decoded)) continue
      if (url.pathname.endsWith('/') || url.pathname === base?.pathname) continue
      url.hash = ''
      results.add(url.toString())
    } catch {
      // Ignore malformed and non-URL hrefs in the user-supplied listing.
    }
  }
  return [...results]
}
