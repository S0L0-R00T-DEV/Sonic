import { expect, test } from '@playwright/test'
import { fileTypeAllowed, normalizeFileTypes } from '../extension/src/fileTypes'
import {
  extractSelectedLinks,
  MAX_BATCH_URLS,
  uniqueSupportedLinks
} from '../extension/src/linkSelection'

test.describe('explicit browser context-menu link collection', () => {
  test('normalizes relative URLs, strips fragments, deduplicates and omits the current page', () => {
    expect(
      uniqueSupportedLinks(
        [
          '/downloads/a.zip#first',
          'https://example.com/downloads/a.zip#second',
          'https://example.com/index.html',
          'javascript:alert(1)',
          'https://user:password@example.com/private.zip',
          'data:text/plain,hello',
          'https://cdn.example.com/b.iso'
        ],
        'https://example.com/index.html'
      )
    ).toEqual(['https://example.com/downloads/a.zip', 'https://cdn.example.com/b.iso'])
  })

  test('selected text extracts only supported URLs and trims punctuation', () => {
    expect(
      extractSelectedLinks(
        'Files: https://example.com/a.zip, https://example.com/a.zip#download. and magnet:?xt=urn:btih:abcd). javascript:alert(1)'
      )
    ).toEqual(['https://example.com/a.zip', 'magnet:?xt=urn:btih:abcd'])
  })

  test(`page collection is capped at ${MAX_BATCH_URLS} distinct URLs`, () => {
    const links = Array.from(
      { length: MAX_BATCH_URLS + 20 },
      (_, index) => `https://downloads.example/file-${index}.zip`
    )
    const result = uniqueSupportedLinks(links, 'https://example.com/index.html')
    expect(result).toHaveLength(MAX_BATCH_URLS)
    expect(new Set(result).size).toBe(MAX_BATCH_URLS)
  })
})

test.describe('automatic browser-capture file-type rules', () => {
  test('normalizes and bounds extension lists', () => {
    expect(normalizeFileTypes('.ZIP, pdf; 7z, zip, ../unsafe, *')).toEqual(['zip', 'pdf', '7z'])
    expect(normalizeFileTypes(['PDF', '.iso', 'no/slash', ''])).toEqual(['pdf', 'iso'])
  })

  test('allow/deny matching is case-insensitive and manual handoffs remain separate', () => {
    const types = normalizeFileTypes('zip, iso')
    expect(fileTypeAllowed('C:\\Downloads\\archive.ZIP', 'allow', types)).toBe(true)
    expect(fileTypeAllowed('https://example.com/movies/video.mp4', 'allow', types)).toBe(false)
    expect(fileTypeAllowed('report.pdf', 'deny', types)).toBe(true)
    expect(fileTypeAllowed('image.ISO', 'deny', types)).toBe(false)
    expect(fileTypeAllowed('script.exe', 'all', [])).toBe(true)
  })
})
