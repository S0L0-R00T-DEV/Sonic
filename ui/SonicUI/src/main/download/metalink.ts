import { XMLParser, XMLValidator } from 'fast-xml-parser'

export interface MetalinkMirror {
  url: string
  priority: number
}

export interface MetalinkFile {
  name: string
  size?: number
  sha256?: string
  mirrors: MetalinkMirror[]
}

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_FILES = 100
const MAX_MIRRORS_PER_FILE = 100
const METALINK_NAMESPACE = 'urn:ietf:params:xml:ns:metalink'

function childText(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  if (typeof value !== 'object' || value === null) return undefined
  const text = (value as Record<string, unknown>)['#text']
  return typeof text === 'string' || typeof text === 'number' ? String(text).trim() : undefined
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function parseSize(value: unknown): number | undefined {
  const text = childText(value)
  if (!text || !/^\d+$/.test(text)) return undefined
  const size = Number(text)
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined
}

/**
 * Parse the RFC 5854 Metalink XML format without expanding entities or accepting external
 * document types. This parser only returns metadata; callers must still probe and validate each
 * mirror through the normal transfer policy before using it.
 */
export function parseMetalinkManifest(xml: string): MetalinkFile[] {
  if (Buffer.byteLength(xml, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error('Metalink manifest exceeds the 2 MiB safety limit')
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new Error('Metalink manifests must not contain a DOCTYPE or entity declarations')
  }
  const validation = XMLValidator.validate(xml)
  if (validation !== true) {
    throw new Error('Metalink manifest is not well-formed XML')
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    processEntities: false,
    parseTagValue: false,
    trimValues: true,
    maxNestedTags: 16
  })
  const rootTag = /<metalink([^>]*)>/i.exec(xml)
  if (!rootTag) throw new Error('Metalink manifest root element is missing')
  const attributes = rootTag[1] ?? ''
  const namespace =
    /xmlns="([^"]*)"/i.exec(attributes)?.[1] ?? /xmlns='([^']*)'/i.exec(attributes)?.[1]
  if (namespace !== METALINK_NAMESPACE) {
    throw new Error('Unsupported Metalink namespace; expected RFC 5854 Metalink v4')
  }
  const parsed = parser.parse(xml) as Record<string, unknown>
  const root = parsed['metalink'] as Record<string, unknown> | undefined
  if (!root || typeof root !== 'object') {
    throw new Error('Metalink manifest root element is missing')
  }

  const rawFiles = asArray(root['file'] as Record<string, unknown> | Record<string, unknown>[])
  if (rawFiles.length === 0 || rawFiles.length > MAX_FILES) {
    throw new Error(`Metalink manifest must contain between 1 and ${MAX_FILES} files`)
  }

  return rawFiles.map((file) => {
    const name = childText(file['@_name'])
    if (
      !name ||
      name.length > 255 ||
      name === '.' ||
      name === '..' ||
      /[\\/\\0-\\x1f\\x7f]/.test(name) ||
      name.includes(':')
    ) {
      throw new Error('Metalink file entry contains an unsafe filename')
    }

    const size = parseSize(file['size'])
    const mirrors = asArray(file['url'] as unknown | unknown[])
      .map((value): MetalinkMirror | undefined => {
        const urlText = childText(value)
        if (!urlText || urlText.length > 8192) return undefined
        let url: URL
        try {
          url = new URL(urlText)
        } catch {
          return undefined
        }
        if (!['http:', 'https:', 'ftp:', 'ftps:'].includes(url.protocol)) return undefined
        if (url.username || url.password || url.hash) return undefined
        const priorityValue =
          typeof value === 'object' && value !== null
            ? Number((value as Record<string, unknown>)['@_priority'] ?? 1)
            : 1
        const priority =
          Number.isInteger(priorityValue) && priorityValue >= 1 && priorityValue <= 999999
            ? priorityValue
            : 1
        return { url: url.toString(), priority }
      })
      .filter((mirror): mirror is MetalinkMirror => mirror !== undefined)
      .sort((a, b) => a.priority - b.priority)
      .slice(0, MAX_MIRRORS_PER_FILE)

    if (mirrors.length === 0) {
      throw new Error(`Metalink entry "${name}" has no supported, safe mirror URLs`)
    }

    const hashes = asArray(file['hash'] as unknown | unknown[])
    const sha256 = hashes
      .map((hash) => {
        if (typeof hash !== 'object' || hash === null) return undefined
        const item = hash as Record<string, unknown>
        return String(item['@_type'] ?? '').toLowerCase() === 'sha-256'
          ? childText(hash)
          : undefined
      })
      .find((hash) => hash !== undefined)

    if (sha256 !== undefined && !/^[a-f\d]{64}$/i.test(sha256)) {
      throw new Error(`Metalink entry "${name}" has an invalid SHA-256 checksum`)
    }

    return { name, ...(size === undefined ? {} : { size }), ...(sha256 ? { sha256 } : {}), mirrors }
  })
}
