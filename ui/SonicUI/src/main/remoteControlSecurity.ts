import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export type RemoteScope = 'status:read' | 'task:add' | 'task:control'

function ipv4Number(address: string): number | null {
  const parts = address
    .replace(/^::ffff:/i, '')
    .split('.')
    .map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return null
  return (((parts[0] << 24) >>> 0) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

/** Only RFC 1918 private IPv4 networks are eligible for the remote listener. */
export function isPrivateLanIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (ipv4Number(address) === null) return false
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  )
}

/** Checks the source IP against the selected Wi-Fi interface's IPv4 subnet. */
export function isSameLocalIPv4Subnet(peer: string, local: string, netmask: string): boolean {
  const remote = ipv4Number(peer)
  const own = ipv4Number(local)
  const mask = ipv4Number(netmask)
  if (remote === null || own === null || mask === null || mask === 0) return false
  const inverse = ~mask >>> 0
  if ((inverse & (inverse + 1)) !== 0) return false
  return (remote & mask) === (own & mask)
}

export interface RemoteDeviceCredential {
  id: string
  label: string
  tokenHash: string
  scopes: RemoteScope[]
  createdAt: number
  expiresAt: number
  revokedAt?: number
}

/** Return a one-time secret for local pairing UI; persist only tokenHash, never token. */
export function createRemoteCredential(
  label: string,
  scopes: RemoteScope[],
  now = Date.now()
): { token: string; credential: RemoteDeviceCredential } {
  const safeLabel = label.trim().slice(0, 64)
  if (!safeLabel) throw new Error('Device label is required.')
  const allowed = new Set<RemoteScope>(['status:read', 'task:add', 'task:control'])
  const normalizedScopes = [...new Set(scopes)]
  if (!normalizedScopes.length || normalizedScopes.some((scope) => !allowed.has(scope))) {
    throw new Error('At least one valid remote-control scope is required.')
  }
  const token = randomBytes(32).toString('base64url')
  return {
    token,
    credential: {
      id: randomBytes(12).toString('hex'),
      label: safeLabel,
      tokenHash: hashRemoteToken(token),
      scopes: normalizedScopes,
      createdAt: now,
      expiresAt: now + 24 * 60 * 60_000
    }
  }
}

export function hashRemoteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Constant-time comparison; revoked and malformed credentials never authenticate. */
export function verifyRemoteCredential(
  token: string,
  credential: RemoteDeviceCredential | undefined
): boolean {
  if (
    !credential ||
    credential.revokedAt !== undefined ||
    !Number.isFinite(credential.expiresAt) ||
    credential.expiresAt <= Date.now() ||
    typeof token !== 'string'
  )
    return false
  const supplied = Buffer.from(hashRemoteToken(token), 'hex')
  const stored = Buffer.from(credential.tokenHash, 'hex')
  return stored.length === supplied.length && timingSafeEqual(stored, supplied)
}

export function remoteScopeAllows(
  credential: RemoteDeviceCredential,
  required: RemoteScope
): boolean {
  return (
    credential.revokedAt === undefined &&
    Number.isFinite(credential.expiresAt) &&
    credential.expiresAt > Date.now() &&
    credential.scopes.includes(required)
  )
}

/** In-memory sliding-window limiter with a hard cap on tracked keys. */
export class RemoteRateLimiter {
  private readonly requests = new Map<string, number[]>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 512
  ) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs < 1) {
      throw new Error('Rate-limit configuration must be positive.')
    }
    if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new Error('maxKeys must be positive.')
  }

  allow(key: string, now = Date.now()): boolean {
    if (!key || key.length > 256) return false
    const cutoff = now - this.windowMs
    for (const [existingKey, times] of this.requests) {
      const fresh = times.filter((time) => time > cutoff)
      if (fresh.length) this.requests.set(existingKey, fresh)
      else this.requests.delete(existingKey)
    }
    let times = this.requests.get(key)
    if (!times) {
      if (this.requests.size >= this.maxKeys) return false
      times = []
      this.requests.set(key, times)
    }
    if (times.length >= this.limit) return false
    times.push(now)
    return true
  }
}
