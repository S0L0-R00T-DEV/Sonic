export const SONIC_PLUGIN_API_VERSION = 1
export const SONIC_PLUGIN_PERMISSIONS = [
  'link.naming',
  'host.resolution',
  'integration.metadata'
] as const
export type SonicPluginPermission = (typeof SONIC_PLUGIN_PERMISSIONS)[number]

export interface SonicPluginFilenameRule {
  host: string
  pathPrefix?: string
  template: string
}
export interface SonicPluginHostResolver {
  host: string
  targetOrigin: string
}
/** Declarative only: plugins cannot ship or execute JavaScript through this manifest format. */
export interface SonicPluginManifest {
  id: string
  name: string
  version: string
  apiVersion: number
  minAppVersion: string
  permissions: SonicPluginPermission[]
  hooks: {
    filenameRules?: SonicPluginFilenameRule[]
    hostResolvers?: SonicPluginHostResolver[]
    integrations?: Array<{ id: string; label: string; homepage: string }>
  }
  signature: { algorithm: 'ed25519'; keyId: string; value: string }
}
export interface PluginManifestValidation {
  valid: boolean
  errors: string[]
  manifest?: SonicPluginManifest
}

export interface PluginSummary {
  id: string
  name: string
  version: string
  keyId: string
  permissions: SonicPluginPermission[]
  grantedPermissions: SonicPluginPermission[]
  enabled: boolean
  hasRollback: boolean
}

export interface PluginReview {
  valid: boolean
  errors: string[]
  summary?: Pick<PluginSummary, 'id' | 'name' | 'version' | 'keyId' | 'permissions'>
}

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const idPattern = /^[a-z0-9](?:[a-z0-9.-]{1,62}[a-z0-9])?$/
const hostPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
const filenameTokens = new Set(['filename', 'basename', 'extension', 'host'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function validHost(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    hostPattern.test(value) &&
    value.toLowerCase() !== 'localhost' &&
    !value.toLowerCase().endsWith('.localhost') &&
    !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
  )
}
function hasControl(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
  )
}
function safeHomepage(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

export function validatePluginManifest(input: unknown): PluginManifestValidation {
  const errors: string[] = []
  if (!isRecord(input)) return { valid: false, errors: ['Manifest must be a JSON object.'] }
  const allowedTop = new Set([
    'id',
    'name',
    'version',
    'apiVersion',
    'minAppVersion',
    'permissions',
    'hooks',
    'signature'
  ])
  for (const key of Object.keys(input))
    if (!allowedTop.has(key)) errors.push(`Unknown manifest field: ${key}`)
  if (typeof input.id !== 'string' || !idPattern.test(input.id))
    errors.push('id must be a lowercase reverse-DNS-style identifier.')
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)
    errors.push('name must contain 1–80 characters.')
  if (typeof input.version !== 'string' || !versionPattern.test(input.version))
    errors.push('version must be semantic version syntax (for example 1.0.0).')
  if (input.apiVersion !== SONIC_PLUGIN_API_VERSION)
    errors.push(`apiVersion must equal ${SONIC_PLUGIN_API_VERSION}.`)
  if (typeof input.minAppVersion !== 'string' || !versionPattern.test(input.minAppVersion))
    errors.push('minAppVersion must be a semantic version.')

  const permissions: SonicPluginPermission[] = []
  if (
    !Array.isArray(input.permissions) ||
    input.permissions.length > SONIC_PLUGIN_PERMISSIONS.length
  ) {
    errors.push('permissions must be an array of known permissions.')
  } else {
    for (const permission of input.permissions) {
      if (!SONIC_PLUGIN_PERMISSIONS.includes(permission as SonicPluginPermission))
        errors.push(`Unknown permission: ${String(permission)}`)
      else if (!permissions.includes(permission as SonicPluginPermission))
        permissions.push(permission as SonicPluginPermission)
    }
  }

  const hooks = input.hooks
  if (!isRecord(hooks)) {
    errors.push('hooks must be an object.')
  } else {
    const allowedHooks = new Set(['filenameRules', 'hostResolvers', 'integrations'])
    for (const key of Object.keys(hooks))
      if (!allowedHooks.has(key)) errors.push(`Unknown hook: ${key}`)
    if (hooks.filenameRules !== undefined) {
      if (!Array.isArray(hooks.filenameRules) || hooks.filenameRules.length > 100)
        errors.push('filenameRules must contain at most 100 rules.')
      else
        hooks.filenameRules.forEach((raw, index) => {
          if (!isRecord(raw) || !validHost(raw.host)) {
            errors.push(
              `filenameRules[${index}].host must be an exact public hostname; wildcards and local/IP hosts are forbidden.`
            )
            return
          }
          if (
            raw.pathPrefix !== undefined &&
            (typeof raw.pathPrefix !== 'string' ||
              !raw.pathPrefix.startsWith('/') ||
              raw.pathPrefix.includes('..') ||
              raw.pathPrefix.length > 512)
          ) {
            errors.push(
              `filenameRules[${index}].pathPrefix must be a bounded absolute path prefix without parent traversal.`
            )
          }
          if (
            typeof raw.template !== 'string' ||
            !raw.template.trim() ||
            raw.template.length > 180 ||
            /[\\/]/.test(raw.template) ||
            (typeof raw.template === 'string' && hasControl(raw.template))
          ) {
            errors.push(
              `filenameRules[${index}].template must be a filename only (no paths or control characters).`
            )
          } else {
            const tokens = [...raw.template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1])
            const stripped = raw.template.replace(/\{(?:filename|basename|extension|host)\}/g, '')
            if (
              tokens.some((token) => !filenameTokens.has(token)) ||
              stripped.includes('{') ||
              stripped.includes('}')
            ) {
              errors.push(`filenameRules[${index}].template uses an unsupported token.`)
            }
          }
        })
    }
    if (hooks.hostResolvers !== undefined) {
      if (!Array.isArray(hooks.hostResolvers) || hooks.hostResolvers.length > 50)
        errors.push('hostResolvers must contain at most 50 rules.')
      else
        hooks.hostResolvers.forEach((raw, index) => {
          if (!isRecord(raw) || !validHost(raw.host)) {
            errors.push(
              `hostResolvers[${index}].host must be an exact public hostname; wildcards and local/IP hosts are forbidden.`
            )
            return
          }
          try {
            const target = new URL(String(raw.targetOrigin ?? ''))
            if (
              target.protocol !== 'https:' ||
              !validHost(target.hostname) ||
              target.username ||
              target.password ||
              target.pathname !== '/' ||
              target.search ||
              target.hash
            )
              errors.push(`hostResolvers[${index}].targetOrigin must be a clean HTTPS origin.`)
          } catch {
            errors.push(`hostResolvers[${index}].targetOrigin must be a clean HTTPS origin.`)
          }
        })
    }
    if (hooks.integrations !== undefined) {
      if (!Array.isArray(hooks.integrations) || hooks.integrations.length > 20)
        errors.push('integrations must contain at most 20 metadata entries.')
      else
        hooks.integrations.forEach((raw, index) => {
          if (
            !isRecord(raw) ||
            typeof raw.id !== 'string' ||
            !idPattern.test(raw.id) ||
            typeof raw.label !== 'string' ||
            !raw.label.trim() ||
            raw.label.length > 80 ||
            !safeHomepage(raw.homepage)
          ) {
            errors.push(`integrations[${index}] must contain a valid id, label and HTTPS homepage.`)
          }
        })
    }
  }
  if (
    !isRecord(input.signature) ||
    input.signature.algorithm !== 'ed25519' ||
    typeof input.signature.keyId !== 'string' ||
    !idPattern.test(input.signature.keyId) ||
    typeof input.signature.value !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(input.signature.value)
  ) {
    errors.push(
      'signature must include an Ed25519 algorithm, trusted keyId and base64 signature value.'
    )
  }
  if (errors.length) return { valid: false, errors }
  return { valid: true, errors, manifest: input as unknown as SonicPluginManifest }
}

/** Stable signed payload: signature is excluded and fields are serialized in a fixed order. */
export function pluginSigningPayload(manifest: Omit<SonicPluginManifest, 'signature'>): string {
  return JSON.stringify({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    minAppVersion: manifest.minAppVersion,
    permissions: [...manifest.permissions].sort(),
    hooks: {
      filenameRules: manifest.hooks.filenameRules ?? [],
      hostResolvers: manifest.hooks.hostResolvers ?? [],
      integrations: manifest.hooks.integrations ?? []
    }
  })
}

/** Semver lower-bound check for the manifest's declared minimum host version. */
export function isPluginCompatible(manifest: SonicPluginManifest, appVersion: string): boolean {
  const parse = (value: string): { core: number[]; prerelease: string | null } | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
    if (!match) return null
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4] ?? null
    }
  }
  const minimum = parse(manifest.minAppVersion)
  const current = parse(appVersion)
  if (!minimum || !current) return false
  for (let index = 0; index < 3; index++) {
    if (current.core[index] > minimum.core[index]) return true
    if (current.core[index] < minimum.core[index]) return false
  }
  if (minimum.prerelease === null) return current.prerelease === null
  if (current.prerelease === null) return true
  return current.prerelease.localeCompare(minimum.prerelease, undefined, { numeric: true }) >= 0
}

/** Applies only the manifest's declared, permission-gated host rewrite. No code is evaluated. */
export function resolvePluginHost(manifest: SonicPluginManifest, rawUrl: string): string | null {
  if (!manifest.permissions.includes('host.resolution')) return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  const rule = manifest.hooks.hostResolvers?.find(
    (candidate) => candidate.host.toLowerCase() === url.hostname.toLowerCase()
  )
  if (!rule || url.username || url.password || !['http:', 'https:'].includes(url.protocol))
    return null
  const target = new URL(rule.targetOrigin)
  target.pathname = url.pathname
  target.search = url.search
  target.hash = ''
  return target.toString()
}

/** Filename rules are exact-host/path matches and return a basename only. */
export function nameWithPlugin(
  manifest: SonicPluginManifest,
  rawUrl: string,
  currentName: string
): string | null {
  if (!manifest.permissions.includes('link.naming')) return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  const rule = manifest.hooks.filenameRules?.find(
    (candidate) =>
      candidate.host.toLowerCase() === url.hostname.toLowerCase() &&
      (!candidate.pathPrefix || url.pathname.startsWith(candidate.pathPrefix))
  )
  if (!rule) return null
  const dot = currentName.lastIndexOf('.')
  const basename = dot > 0 ? currentName.slice(0, dot) : currentName
  const extension = dot > 0 ? currentName.slice(dot) : ''
  const candidate = rule.template
    .replaceAll('{filename}', currentName)
    .replaceAll('{basename}', basename)
    .replaceAll('{extension}', extension)
    .replaceAll('{host}', url.hostname)
    .replace(/[. ]+$/, '')
    .trim()
  if (
    !candidate ||
    candidate === '.' ||
    candidate === '..' ||
    /[\\/]/.test(candidate) ||
    hasControl(candidate)
  )
    return null
  return candidate.slice(0, 180)
}
