import { defineConfig } from '@playwright/test'
import { networkInterfaces } from 'node:os'

// Set these in the config process, before Playwright imports test files. Mutating environment
// variables in globalSetup is too late for module-level test.skip guards in worker processes.
const localIPv4 = [
  ...new Set(
    Object.entries(networkInterfaces())
      .flatMap(([name, addresses]) =>
        (addresses ?? [])
          .filter(
            (address) =>
              address.family === 'IPv4' &&
              !address.internal &&
              !address.address.startsWith('169.254.')
          )
          .map((address) => ({
            address: address.address,
            virtual: /vEthernet|virtual|WSL|Default Switch|Hyper-V/i.test(name)
          }))
      )
      .sort((left, right) => Number(left.virtual) - Number(right.virtual))
      .map((address) => address.address)
  )
]
if (!process.env.SONIC_E2E_LAN && localIPv4[0]) process.env.SONIC_E2E_LAN = localIPv4[0]
if (!process.env.SONIC_E2E_CHANGED_LAN) {
  const changed = localIPv4.find((address) => address !== process.env.SONIC_E2E_LAN)
  if (changed) process.env.SONIC_E2E_CHANGED_LAN = changed
}
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  // Deliberately 0, including on CI: a download test that only passes on a retry has found a
  // race, and retrying would hide exactly what this suite exists to catch.
  retries: 0,
  // The Electron main process and the legacy .NET queue backend currently expose fixed local
  // named pipes. Running multiple app instances in parallel collides with those endpoints and can
  // make unrelated tests read each other's history. Keep the suite deterministic until endpoints
  // are instance-scoped.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list'
})
