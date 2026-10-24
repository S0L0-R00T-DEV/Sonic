import { execSync } from 'node:child_process'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'

/** The second test "network" is this machine's LAN address, bound as the source of requests to
 * the loopback test server. Most systems route that fine; check once rather than assume, and
 * leave SONIC_E2E_LAN empty (multi-network tests skip) where it doesn't work. */
async function findLanAddress(): Promise<string> {
  // Virtual adapters can be enumerated before the Wi-Fi/Ethernet adapter and may not route
  // source-bound traffic to loopback. Try every assigned IPv4 address instead of letting one
  // unusable candidate disable all multi-network integration coverage.
  const candidates = Object.values(networkInterfaces())
    .flat()
    .filter(
      (addr): addr is NonNullable<typeof addr> =>
        !!addr && addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')
    )
    .map((addr) => addr.address)
  if (candidates.length === 0) return ''

  const server = createServer((_req, res) => res.end('ok'))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', resolve)
  })
  const { port } = server.address() as AddressInfo
  try {
    for (const candidate of candidates) {
      const works = await new Promise<boolean>((resolve) => {
        const req = request(
          { host: '127.0.0.1', port, localAddress: candidate, family: 4 },
          (res) => {
            res.resume()
            resolve(res.statusCode === 200)
          }
        )
        req.setTimeout(2000, () => req.destroy())
        req.on('error', () => resolve(false))
        req.end()
      })
      if (works) return candidate
    }
    return ''
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** Tests launch the built app (out/), so build it first — a stale build tests stale code.
 * SONIC_E2E_SKIP_BUILD=1 skips it when the build is known to be fresh (e.g. a CI step). */
export default async function globalSetup(): Promise<void> {
  if (!process.env.SONIC_E2E_LAN) process.env.SONIC_E2E_LAN = await findLanAddress()
  if (process.env.SONIC_E2E_SKIP_BUILD === '1') return
  execSync('npx electron-vite build', { stdio: 'inherit' })
}
