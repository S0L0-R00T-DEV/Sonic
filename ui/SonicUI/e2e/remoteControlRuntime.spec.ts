import { expect, test } from './fixtures'

test.describe('F-16/F-17 local Wi-Fi remote control', () => {
  test('remote listener is disabled by default and the companion is part of Settings', async ({
    sonic
  }) => {
    const state = await sonic.api.remoteControlState()
    expect(state.enabled).toBe(false)
    expect(state.url).toBeNull()
    expect(state.pairingExpiresAt).toBeNull()
    expect(
      state.wifiInterfaces.every((item) =>
        item.addresses.every((ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip))
      )
    ).toBe(true)

    await sonic.page.getByRole('button', { name: /settings/i }).click()
    await expect(
      sonic.page.getByRole('heading', { name: 'Local Wi-Fi remote control' })
    ).toBeVisible()
    await expect(
      sonic.page.getByText(
        /No cloud relay, internet listener, Ethernet\/USB interface, port forwarding/i
      )
    ).toBeVisible()
    if (state.wifiInterfaces.length === 0) {
      await expect(
        sonic.page.getByRole('button', { name: 'Enable on this Wi-Fi only' })
      ).toBeDisabled()
    }
  })
})
