import { expect, test } from '@playwright/test'
import {
  createRemoteCredential,
  isPrivateLanIPv4,
  isSameLocalIPv4Subnet,
  remoteScopeAllows,
  RemoteRateLimiter,
  verifyRemoteCredential
} from '../src/main/remoteControlSecurity'

test.describe('remote-control security primitives', () => {
  test('issues high-entropy one-time tokens and stores only a hash', () => {
    const now = Date.now()
    const first = createRemoteCredential('Phone', ['status:read', 'task:control'], now)
    const second = createRemoteCredential('Phone', ['status:read'], now)
    expect(first.token).not.toBe(second.token)
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(first.credential.tokenHash).not.toContain(first.token)
    expect(verifyRemoteCredential(first.token, first.credential)).toBe(true)
    expect(verifyRemoteCredential('wrong-token', first.credential)).toBe(false)
    expect(verifyRemoteCredential(first.token, undefined)).toBe(false)
  })

  test('expires device credentials after 24 hours', () => {
    const now = Date.now() - 25 * 60 * 60_000
    const issued = createRemoteCredential('Expired phone', ['status:read'], now)
    expect(issued.credential.expiresAt).toBe(now + 24 * 60 * 60_000)
    expect(verifyRemoteCredential(issued.token, issued.credential)).toBe(false)
    expect(remoteScopeAllows(issued.credential, 'status:read')).toBe(false)
  })

  test('enforces per-device scopes and immediate revocation', () => {
    const { token, credential } = createRemoteCredential('Companion', ['status:read'])
    expect(verifyRemoteCredential(token, credential)).toBe(true)
    expect(remoteScopeAllows(credential, 'status:read')).toBe(true)
    expect(remoteScopeAllows(credential, 'task:add')).toBe(false)
    expect(verifyRemoteCredential(token, { ...credential, revokedAt: Date.now() })).toBe(false)
    expect(remoteScopeAllows({ ...credential, revokedAt: Date.now() }, 'status:read')).toBe(false)
  })

  test('rejects empty labels and invalid scopes', () => {
    expect(() => createRemoteCredential('  ', ['status:read'])).toThrow(/label/i)
    expect(() => createRemoteCredential('Phone', ['admin' as 'status:read'])).toThrow(/scope/i)
  })

  test('allows only RFC 1918 Wi-Fi addresses and enforces the selected subnet', () => {
    expect(isPrivateLanIPv4('10.8.1.2')).toBe(true)
    expect(isPrivateLanIPv4('172.31.2.3')).toBe(true)
    expect(isPrivateLanIPv4('192.168.1.14')).toBe(true)
    expect(isPrivateLanIPv4('172.32.0.1')).toBe(false)
    expect(isPrivateLanIPv4('8.8.8.8')).toBe(false)
    expect(isPrivateLanIPv4('127.0.0.1')).toBe(false)
    expect(isSameLocalIPv4Subnet('192.168.1.20', '192.168.1.14', '255.255.255.0')).toBe(true)
    expect(isSameLocalIPv4Subnet('192.168.2.20', '192.168.1.14', '255.255.255.0')).toBe(false)
    expect(isSameLocalIPv4Subnet('8.8.8.8', '192.168.1.14', '255.255.255.0')).toBe(false)
    expect(isSameLocalIPv4Subnet('192.168.1.20', '192.168.1.14', '255.0.255.0')).toBe(false)
  })

  test('applies a sliding-window rate limit and caps tracked keys', () => {
    const limiter = new RemoteRateLimiter(2, 1000, 2)
    expect(limiter.allow('device-a', 1000)).toBe(true)
    expect(limiter.allow('device-a', 1100)).toBe(true)
    expect(limiter.allow('device-a', 1200)).toBe(false)
    expect(limiter.allow('device-b', 1200)).toBe(true)
    expect(limiter.allow('device-c', 1200)).toBe(false)
    expect(limiter.allow('device-a', 2101)).toBe(true)
    expect(limiter.allow('', 2200)).toBe(false)
  })
})
