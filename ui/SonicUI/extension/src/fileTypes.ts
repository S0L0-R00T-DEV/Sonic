import type { FileTypeMode } from './defaults'

/** Parses a comma/space/semicolon-separated list of filename extensions. */
export function normalizeFileTypes(value: string | readonly string[]): string[] {
  const candidates = typeof value === 'string' ? value.split(/[\s,;]+/) : value
  const normalized = new Set<string>()
  for (const candidate of candidates) {
    const extension = candidate.trim().toLowerCase().replace(/^\.+/, '')
    if (
      !extension ||
      extension.length > 31 ||
      !/^[a-z0-9][a-z0-9._+-]*$/.test(extension) ||
      extension.includes('..') ||
      extension.endsWith('.')
    ) {
      continue
    }
    normalized.add(extension)
    if (normalized.size >= 100) break
  }
  return [...normalized]
}

/** Rules apply to automatic capture; deliberate context-menu handoffs are user overrides. */
export function fileTypeAllowed(
  fileNameOrUrl: string,
  mode: FileTypeMode,
  extensions: readonly string[]
): boolean {
  if (mode === 'all') return true
  let name = fileNameOrUrl
  try {
    if (/^https?:\/\//i.test(fileNameOrUrl)) name = new URL(fileNameOrUrl).pathname
  } catch {
    // Treat the value as a filename below; no unsafe URL is fetched here.
  }
  const fileName = name.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  const matches = extensions.some((extension) => fileName.endsWith(`.${extension}`))
  return mode === 'allow' ? matches : !matches
}
