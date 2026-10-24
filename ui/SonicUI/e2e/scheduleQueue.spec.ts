import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_DOWNLOAD_SCHEDULE } from '../src/shared/downloadSchedule'
import { BLOCK, expect, test, type SonicApp } from './fixtures'
import { named, Swarm, torrentFileOnDisk } from './torrentSwarm'
import { seededBytes, sha256 } from './origin'

const schedule = { ...DEFAULT_DOWNLOAD_SCHEDULE, enabled: true }
const at = (day: number, hour: number): number => new Date(2000, 0, day, hour).getTime()

async function clock(sonic: SonicApp, now: number, wake = true): Promise<void> {
  await sonic.evaluateMain(
    ({ powerMonitor }, value) => {
      Date.now = () => value.now
      if (value.wake) powerMonitor.emit('resume')
    },
    { now, wake }
  )
}

test('scheduled queue holds new downloads and manual resumes; manually paused downloads stay paused @smoke', async ({
  sonic,
  serve
}) => {
  await clock(sonic, at(1, 8))
  await sonic.api.updateSettings({ downloadSchedule: schedule, downloadsAtOnce: 1 })
  const origin = await serve({ size: 24 * BLOCK })
  const first = await sonic.start(origin.url('/first'), origin.sha256)
  const second = await sonic.start(origin.url('/second'), origin.sha256)
  expect((await sonic.byId(first))?.status).toBe('queued')
  expect((await sonic.byId(second))?.bytesDownloaded).toBe(0)
  await sonic.api.pauseDownload(first)
  await sonic.api.resumeDownload(first)
  await expect.poll(async () => (await sonic.byId(first))?.status).toBe('queued')
  await sonic.api.pauseDownload(first)
  await clock(sonic, at(2, 0))
  await expect.poll(async () => (await sonic.byId(second))?.status).toBe('completed')
  expect((await sonic.byId(first))?.status).toBe('paused')
  await sonic.api.resumeDownload(first)
  await expect.poll(async () => (await sonic.byId(first))?.status).toBe('completed')
})

test('the clock cutoff stops active HTTP transfers, preserves progress, and blocks queue draining', async ({
  sonic,
  serve
}) => {
  await clock(sonic, at(1, 0))
  await sonic.api.updateSettings({ downloadSchedule: schedule, downloadsAtOnce: 1 })
  const origin = await serve({ size: 24 * BLOCK })
  const held = origin.hold(4 * BLOCK)
  const id = await sonic.start(origin.url(), origin.sha256)
  await held
  const next = await sonic.start(origin.url('/next'), origin.sha256)
  // No wake event: the main-process timer must enforce the cutoff itself.
  await clock(sonic, at(1, 7), false)
  await expect.poll(async () => (await sonic.byId(id))?.status).toBe('queued')
  const stopped = await sonic.byId(id)
  expect(stopped?.bytesDownloaded).toBeGreaterThan(0)
  expect(stopped?.speedBytesPerSec).toBe(0)
  expect((await sonic.byId(next))?.bytesDownloaded).toBe(0)
  origin.release()
  await clock(sonic, at(2, 0))
  await expect.poll(async () => (await sonic.byId(id))?.status).toBe('completed')
  await expect.poll(async () => (await sonic.byId(next))?.status).toBe('completed')
})

test('scheduled intent survives restart, while expiration stays blocked until disabled', async ({
  sonic,
  serve
}) => {
  await clock(sonic, at(1, 8))
  await sonic.api.updateSettings({ downloadSchedule: { ...schedule, endDate: '2000-01-02' } })
  const origin = await serve({ size: 16 * BLOCK })
  const id = await sonic.start(origin.url(), origin.sha256)
  await sonic.relaunch()
  expect((await sonic.byId(id))?.status).toBe('queued')
  expect((await sonic.byId(id))?.bytesDownloaded).toBe(0)
  await sonic.api.updateSettings({ downloadSchedule: { ...schedule, enabled: false } })
  await expect.poll(async () => (await sonic.byId(id))?.status).toBe('completed')
})

test('a restart inside the window continues scheduled work', async ({ sonic, serve }) => {
  const minute = new Date().getHours() * 60 + new Date().getMinutes()
  const open = { ...schedule, startMinute: (minute + 1420) % 1440, endMinute: (minute + 20) % 1440 }
  await sonic.api.updateSettings({ downloadSchedule: open })
  const origin = await serve({ size: 24 * BLOCK })
  const held = origin.hold(4 * BLOCK)
  const id = await sonic.start(origin.url(), origin.sha256)
  await held
  await sonic.quit()
  origin.release()
  await sonic.launch()
  await expect.poll(async () => (await sonic.byId(id))?.status).toBe('completed')
})

test('the cutoff stops torrent peers and uploads; reopening finishes the same file', async ({
  sonic
}) => {
  const swarm = await new Swarm().start()
  try {
    await clock(sonic, at(1, 0))
    await sonic.api.updateSettings({ downloadSchedule: schedule, speedLimit: 128 * 1024 })
    const data = seededBytes(2 * 1024 * 1024, 32)
    const torrent = await swarm.seed([named(data, 'scheduled.bin')], { pieceLength: 64 * 1024 })
    const id = await sonic.start(await torrentFileOnDisk(torrent), sha256(data))
    await sonic.waitUntil((state) => state.bytesDownloaded > 0)
    await clock(sonic, at(1, 7))
    await expect.poll(async () => (await sonic.byId(id))?.status).toBe('queued')
    // Saving a closed window waits for the client to finish closing.
    await sonic.api.updateSettings({ downloadSchedule: schedule })
    const stopped = await sonic.byId(id)
    expect(stopped?.speedBytesPerSec).toBe(0)
    if (stopped?.kind === 'torrent') expect(stopped.uploadSpeedBytesPerSec).toBe(0)
    await clock(sonic, at(2, 0))
    await sonic.api.updateSettings({ speedLimit: undefined })
    await expect
      .poll(async () => (await sonic.byId(id))?.status, { timeout: 30_000 })
      .toBe('completed')
  } finally {
    await swarm.stop()
  }
})

async function openSchedule(sonic: SonicApp): Promise<void> {
  await sonic.page.getByRole('button', { name: 'Open settings', exact: true }).click()
  await sonic.page.getByRole('region', { name: 'Download schedule' }).scrollIntoViewIfNeeded()
}

async function chooseTime(sonic: SonicApp, label: string, time: string): Promise<void> {
  const [hour, minute] = time.split(':')
  for (const [part, value] of [
    ['hour', hour],
    ['minute', minute]
  ]) {
    await sonic.page.getByRole('spinbutton', { name: `${label} ${part}`, exact: true }).fill(value)
  }
}

test('schedule dialog saves, cancels edits, validates times, and restores settings', async ({
  sonic
}, testInfo) => {
  const page = sonic.page
  const indicator = page.getByRole('button', { name: 'Download schedule enabled', exact: true })
  await expect(indicator).toBeHidden()
  await openSchedule(sonic)
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('group', { name: 'Start at', exact: true })).toBeHidden()
  await dialog.getByRole('switch', { name: 'Enable download schedule' }).check()
  await chooseTime(sonic, 'Start at', '00:00')
  await chooseTime(sonic, 'Stop at', '00:00')
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await chooseTime(sonic, 'Stop at', '07:00')
  await expect(dialog.locator('input[type="date"], input[type="time"]')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Mon', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Mon', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  await chooseTime(sonic, 'Stop at', '07:13')
  await chooseTime(sonic, 'Stop at', '07:00')
  await dialog.getByRole('button', { name: 'End date', exact: true }).click()
  const calendar = page.getByRole('dialog', { name: 'Choose end date' })
  await calendar.getByRole('button', { name: 'Go to the next month' }).click()
  await page.screenshot({ path: '/tmp/sonic-schedule-calendar.png' })
  // Choose a day in the displayed month, excluding the adjacent months' trailing dates.
  await calendar
    .locator('[data-slot="calendar"] td:not([data-outside]) button')
    .filter({ hasText: /^15$/ })
    .click()
  const endDateLabel = await dialog
    .getByRole('button', { name: 'End date', exact: true })
    .innerText()
  await testInfo.attach('schedule-dialog.png', {
    body: await page.screenshot({ path: '/tmp/sonic-schedule-dialog.png' }),
    contentType: 'image/png'
  })
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(indicator).toBeVisible()
  await page.screenshot({ path: '/tmp/sonic-schedule-toolbar.png' })
  await indicator.click()
  await expect(dialog.getByRole('switch', { name: 'Enable download schedule' })).toBeFocused()
  await expect(dialog.getByRole('region', { name: 'Download schedule' })).toBeInViewport()
  await expect(dialog.getByRole('button', { name: 'End date', exact: true })).toBeInViewport({
    ratio: 1
  })
  // Change a saved value, then cancel: the persisted schedule must remain unchanged.
  await chooseTime(sonic, 'Stop at', '09:00')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await sonic.relaunch()
  await openSchedule(sonic)
  const restored = sonic.page.getByRole('dialog', { name: 'Settings' })
  await expect(restored.getByRole('switch', { name: 'Enable download schedule' })).toBeChecked()
  await expect(restored.getByRole('spinbutton', { name: 'Stop at hour', exact: true })).toHaveValue(
    '07'
  )
  await expect(restored.getByRole('button', { name: 'End date', exact: true })).toHaveText(
    endDateLabel
  )
  await expect(restored.getByRole('button', { name: 'Mon', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  await restored.getByRole('button', { name: 'End date', exact: true }).click()
  await sonic.page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(restored.getByRole('button', { name: 'End date', exact: true })).toHaveText(
    'No end date'
  )
  await restored.getByRole('switch', { name: 'Enable download schedule' }).uncheck()
  await restored.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    sonic.page.getByRole('button', { name: 'Download schedule enabled', exact: true })
  ).toBeHidden()
})

test('an overnight schedule remains usable at the minimum window size', async ({ sonic }) => {
  await sonic.evaluateMain(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(720, 620)
  }, null)
  await sonic.page.emulateMedia({ colorScheme: 'dark' })
  await openSchedule(sonic)
  const dialog = sonic.page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('switch', { name: 'Enable download schedule' }).check()
  await chooseTime(sonic, 'Start at', '22:00')
  const minute = dialog.getByRole('spinbutton', { name: 'Start at minute', exact: true })
  const hour = dialog.getByRole('spinbutton', { name: 'Start at hour', exact: true })
  await minute.focus()
  await sonic.page.keyboard.press('ArrowDown')
  await expect(minute).toHaveValue('59')
  await expect(minute).toHaveAttribute('aria-valuenow', '59')
  await sonic.page.keyboard.press('ArrowUp')
  await expect(minute).toHaveValue('00')
  await sonic.page.keyboard.press('ArrowLeft')
  await expect(hour).toBeFocused()
  await sonic.page.keyboard.press('End')
  await expect(hour).toHaveValue('23')
  await sonic.page.keyboard.press('ArrowUp')
  await expect(hour).toHaveValue('00')
  await hour.evaluate((input) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', '21:37')
    input.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
    )
  })
  await expect(hour).toHaveValue('21')
  await expect(minute).toHaveValue('37')
  await hour.focus()
  await sonic.page.keyboard.press('ControlOrMeta+A')
  await hour.pressSequentially('22')
  await expect(minute).toBeFocused()
  await minute.fill('00')
  await minute.fill('75')
  await expect(minute).toHaveValue('00')
  await sonic.page.screenshot({ path: '/tmp/sonic-schedule-time-dark.png' })
  await expect(dialog.getByText('Next day', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Save', exact: true }).scrollIntoViewIfNeeded()
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeInViewport({
    ratio: 1
  })
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
})

test('main refuses invalid schedule changes without clearing the existing window', async ({
  sonic,
  serve
}) => {
  await clock(sonic, at(1, 8))
  await sonic.api.updateSettings({ downloadSchedule: schedule })
  await expect(
    sonic.api.updateSettings({ downloadSchedule: { ...schedule, days: [] } })
  ).rejects.toThrow()
  const origin = await serve({ size: 8 * BLOCK })
  const id = await sonic.start(origin.url(), origin.sha256)
  expect((await sonic.byId(id))?.status).toBe('queued')
  await sonic.api.updateSettings({ downloadSchedule: { ...schedule, enabled: false } })
  await expect.poll(async () => (await sonic.byId(id))?.status).toBe('completed')
})

test('quitting during the cutoff saves progress and leaves the restored queue stopped', async ({
  sonic,
  serve
}) => {
  await clock(sonic, at(1, 0))
  await sonic.api.updateSettings({ downloadSchedule: { ...schedule, endDate: '2000-01-02' } })
  const origin = await serve({ size: 24 * BLOCK })
  const held = origin.hold(4 * BLOCK)
  const id = await sonic.start(origin.url(), origin.sha256)
  await held
  await clock(sonic, at(1, 7))
  await sonic.quit()
  origin.release()
  await sonic.launch()
  const restored = await sonic.byId(id)
  expect(restored?.status).toBe('queued')
  expect(restored?.bytesDownloaded).toBeGreaterThan(0)
  await sonic.api.updateSettings({ downloadSchedule: { ...schedule, enabled: false } })
  await expect.poll(async () => (await sonic.byId(id))?.status).toBe('completed')
})

test('enabling a closed window adopts active work; a manual pause survives its cutoff and restart', async ({
  sonic,
  serve
}) => {
  const origin = await serve({ size: 24 * BLOCK })
  const held = origin.hold(4 * BLOCK)
  await sonic.api.updateSettings({ downloadsAtOnce: 1 })
  const active = await sonic.start(origin.url('/active'), origin.sha256)
  await held
  const waiting = await sonic.start(origin.url('/waiting'), origin.sha256)
  await clock(sonic, at(1, 8))
  await sonic.api.updateSettings({ downloadSchedule: schedule })
  const stopped = await sonic.byId(active)
  expect(stopped?.status).toBe('queued')
  expect(stopped?.scheduled).toBe(true)
  expect((await sonic.byId(waiting))?.scheduled).toBe(true)
  await sonic.api.pauseDownload(active)
  await sonic.quit()
  origin.release()
  await sonic.launch()
  expect((await sonic.byId(active))?.status).toBe('paused')
  // Whichever local time the app restarted in, the scheduled entry can run when disabled.
  await sonic.api.updateSettings({ downloadSchedule: { ...schedule, enabled: false } })
  await expect.poll(async () => (await sonic.byId(waiting))?.status).toBe('completed')
  expect((await sonic.byId(active))?.status).toBe('paused')
  await sonic.api.resumeDownload(active)
  await expect.poll(async () => (await sonic.byId(active))?.status).toBe('completed')
})

test('a malformed saved schedule blocks transfers and can be disabled from settings', async ({
  sonic,
  serve,
  dirs
}) => {
  await clock(sonic, at(1, 8))
  await sonic.api.updateSettings({ downloadSchedule: schedule })
  const origin = await serve({ size: 8 * BLOCK })
  const id = await sonic.start(origin.url(), origin.sha256)
  await sonic.quit()
  await writeFile(
    join(dirs.userData, 'app-settings.json'),
    JSON.stringify({
      downloadSchedule: { ...schedule, days: [] }
    })
  )
  await sonic.launch()
  expect((await sonic.byId(id))?.status).toBe('queued')
  expect((await sonic.byId(id))?.bytesDownloaded).toBe(0)
  await openSchedule(sonic)
  const dialog = sonic.page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await dialog.getByRole('switch', { name: 'Enable download schedule' }).uncheck()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await sonic.byId(id))?.status).toBe('completed')
})
