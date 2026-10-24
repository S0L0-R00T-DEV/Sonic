import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { expect, test } from './fixtures'

test.use({
  appEnv: {
    SONIC_E2E_INTERFACES: 'Wi-Fi=127.0.0.1=255.0.0.0=wifi',
    SONIC_E2E_REMOTE_LOOPBACK: '1'
  }
})

async function requestText(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      target,
      { rejectUnauthorized: false, headers: { Host: new URL(target).host }, timeout: 3000 },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      }
    )
    req.on('timeout', () => req.destroy(new Error('Companion page request timed out.')))
    req.on('error', reject)
    req.end()
  })
}

async function requestJson(
  target: string,
  method = 'GET',
  body?: Record<string, unknown>,
  token?: string
): Promise<{ status: number; body: Record<string, unknown>; subjectAltName?: string }> {
  return new Promise((resolve, reject) => {
    const encoded = body ? Buffer.from(JSON.stringify(body)) : undefined
    const headers: Record<string, string> = { Host: new URL(target).host }
    if (encoded) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(encoded.length)
    }
    if (token) headers.Authorization = 'Bearer ' + token
    if (method === 'POST' && target.endsWith('/api/tasks'))
      headers['Idempotency-Key'] = 'test-add-00000001'
    const req = httpsRequest(
      target,
      {
        method,
        headers,
        rejectUnauthorized: false,
        timeout: 3000
      },
      (response: IncomingMessage) => {
        const subjectAltName = (response.socket as TLSSocket | null)?.getPeerCertificate()
          ?.subjectaltname
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => {
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          } catch {
            reject(new Error('Remote API did not return JSON.'))
            return
          }
          resolve({
            status: response.statusCode ?? 0,
            body: parsed,
            subjectAltName
          })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('Remote API request timed out.')))
    req.on('error', reject)
    if (encoded) req.write(encoded)
    req.end()
  })
}

test('F-16 TLS API pairs scoped phones, authorizes requests and revokes credentials', async ({
  sonic
}) => {
  const initial = await sonic.api.remoteControlState()
  expect(initial.enabled).toBe(false)
  expect(initial.url).toBeNull()
  expect(initial.wifiInterfaces.map((item) => item.id)).toContain('Wi-Fi')

  let url = ''
  let token = ''
  let deviceId = ''
  try {
    const enabled = await sonic.api.enableRemoteControl('Wi-Fi')
    expect(enabled.enabled).toBe(true)
    expect(enabled.url).toBe('https://127.0.0.1:47831/')
    expect(enabled.caFingerprint).toMatch(/^([A-F0-9]{2}:){31}[A-F0-9]{2}$/)
    url = enabled.url!
    const companion = await requestText(url)
    expect(companion).toContain('Pair this phone')
    expect(companion).toContain('Add a download')
    expect(companion).toContain('localStorage')
    expect(companion).not.toContain('cdn.jsdelivr.net')

    const unauthenticated = await requestJson(new URL('/api/status', url).toString())
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.subjectAltName).toContain('IP Address:127.0.0.1')

    const pairing = await sonic.api.createRemotePairingCode(['status:read'])
    const paired = await requestJson(new URL('/api/pair', url).toString(), 'POST', {
      code: pairing.code,
      label: 'Test phone'
    })
    expect(paired.status).toBe(201)
    token = String(paired.body.token)
    deviceId = String(paired.body.deviceId)
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/)

    const status = await requestJson(
      new URL('/api/status', url).toString(),
      'GET',
      undefined,
      token
    )
    expect(status.status).toBe(200)
    expect(Array.isArray(status.body.downloads)).toBe(true)

    const denied = await requestJson(
      new URL('/api/tasks', url).toString(),
      'POST',
      { url: 'https://example.invalid/file.bin' },
      token
    )
    expect(denied.status).toBe(401)

    const replay = await requestJson(new URL('/api/pair', url).toString(), 'POST', {
      code: pairing.code,
      label: 'Replay phone'
    })
    expect(replay.status).toBe(410)

    await sonic.api.revokeRemoteDevice(deviceId)
    const revoked = await requestJson(
      new URL('/api/status', url).toString(),
      'GET',
      undefined,
      token
    )
    expect(revoked.status).toBe(401)
  } finally {
    await sonic.api.disableRemoteControl().catch(() => {})
  }

  expect((await sonic.api.remoteControlState()).enabled).toBe(false)
  await expect(requestJson(new URL('/health', url).toString())).rejects.toThrow()
})
