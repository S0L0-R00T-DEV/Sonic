import { BLOCK, expect, test } from './fixtures'

test('search filters downloads, empty results recover, and sorting is predictable', async ({
  sonic,
  serve
}) => {
  const alpha = await serve({ size: BLOCK })
  const beta = await serve({ size: BLOCK * 2 })
  await sonic.start(alpha.url(), alpha.sha256, { fileName: 'alpha.bin' })
  await sonic.waitForHttpStatus('completed')
  await sonic.start(beta.url(), beta.sha256, { fileName: 'beta.bin' })
  await sonic.waitForHttpStatus('completed')

  const page = sonic.page
  const finished = page.getByRole('region', { name: 'Finished' })
  await expect(finished.getByRole('button', { name: 'Open alpha.bin', exact: true })).toBeVisible()
  await expect(finished.getByRole('button', { name: 'Open beta.bin', exact: true })).toBeVisible()

  await page.getByRole('searchbox', { name: 'Search downloads' }).fill('alpha')
  await expect(finished.getByRole('button', { name: 'Open alpha.bin', exact: true })).toBeVisible()
  await expect(finished.getByRole('button', { name: 'Open beta.bin', exact: true })).toHaveCount(0)
  await page.getByRole('searchbox', { name: 'Search downloads' }).fill('not-a-real-download')
  await expect(page.getByRole('status')).toContainText('No downloads match')
  await page.getByRole('button', { name: 'Clear search' }).click()

  await page.getByLabel('Sort downloads').selectOption('name')
  let labels = await finished
    .locator('button[aria-label^="Open "]')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))
  expect(labels.slice(0, 2)).toEqual(['Open alpha.bin', 'Open beta.bin'])

  await page.getByLabel('Sort downloads').selectOption('size')
  labels = await finished
    .locator('button[aria-label^="Open "]')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))
  expect(labels.slice(0, 2)).toEqual(['Open beta.bin', 'Open alpha.bin'])
})
