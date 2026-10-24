import { expect, test } from './fixtures'

const EXTENSION_ORIGIN = 'chrome-extension://sonic-e2e-test'
const BRIDGE_PORTS = [19288, 19289, 19290]
const MAGNET = `magnet:?xt=urn:btih:${'cd'.repeat(20)}&dn=browser-handoff-test`

async function bridgePort(): Promise<number> {
  for (const port of BRIDGE_PORTS) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ping`, {
        headers: { Origin: EXTENSION_ORIGIN },
        signal: AbortSignal.timeout(1000)
      })
      if (response.ok) {
        const body = (await response.json()) as { app?: string; api?: number }
        if (body.app === 'sonic') return port
      }
    } catch {
      // Try the next port: Sonic uses the first one not occupied by another process.
    }
  }
  throw new Error('Sonic browser bridge was not listening on any configured port.')
}

const postJson = (port: number, path: string, body: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { Origin: EXTENSION_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  })

test.describe('browser extension bridge', () => {
  test('rejects web-page origins and permits the extension preflight', async () => {
    const port = await bridgePort()
    const pageRequest = await fetch(`http://127.0.0.1:${port}/ping`, {
      headers: { Origin: 'https://attacker.example' }
    })
    expect(pageRequest.status).toBe(403)

    const preflight = await fetch(`http://127.0.0.1:${port}/add`, {
      method: 'OPTIONS',
      headers: {
        Origin: EXTENSION_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type'
      }
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(EXTENSION_ORIGIN)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')
  })

  test('caps pending handoffs instead of allowing unbounded token growth', async () => {
    const port = await bridgePort()
    for (let index = 0; index < 128; index++) {
      const offered = await postJson(port, '/add', { url: `${MAGNET}&batch=${index}` })
      expect(offered.status, `handoff ${index + 1} should be accepted`).toBe(200)
    }
    const capped = await postJson(port, '/add', { url: MAGNET })
    expect(capped.status).toBe(422)
    expect(await capped.json()).toMatchObject({
      reason: expect.stringMatching(/Too many pending browser links/i)
    })
  })

  test('uses a one-time handoff token and opens the link for user review without starting it', async ({
    sonic
  }) => {
    const port = await bridgePort()
    const offered = await postJson(port, '/add', { url: MAGNET })
    expect(offered.status).toBe(200)
    const payload = (await offered.json()) as { token?: unknown }
    expect(typeof payload.token).toBe('string')

    const confirmed = await postJson(port, '/confirm', { token: payload.token })
    expect(confirmed.status).toBe(200)
    await expect(sonic.page.getByRole('textbox', { name: 'Link' })).toHaveValue(MAGNET)
    expect(await sonic.current(), 'handoff fills the composer but never auto-starts').toBeNull()

    const replayed = await postJson(port, '/confirm', { token: payload.token })
    expect(replayed.status).toBe(410)
    expect(await sonic.current()).toBeNull()
  })
})
