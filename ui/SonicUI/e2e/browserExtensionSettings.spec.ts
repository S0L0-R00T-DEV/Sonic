import { expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../extension/src/defaults'

test('automatic browser interception is opt-in by default', () => {
  expect(DEFAULT_SETTINGS.capture).toBe(false)
  expect(DEFAULT_SETTINGS.sites).toEqual([])
  expect(DEFAULT_SETTINGS.skipSmall).toBe(false)
  expect(DEFAULT_SETTINGS.minMegabytes).toBe(1)
  expect(DEFAULT_SETTINGS.fileTypeMode).toBe('all')
  expect(DEFAULT_SETTINGS.fileTypes).toEqual([])
})
