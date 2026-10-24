import { expect, test } from './fixtures'
import { directoryListingLinks } from '../src/renderer/src/utils/batchLinks'

test('directory listing import resolves only bounded same-directory file links', () => {
  const links = directoryListingLinks(
    `<html><a href="alpha.zip">alpha</a><a href="nested/">nested folder</a><a href="../outside.zip">parent</a><a href="https://evil.example/steal.exe">external</a><a href="https://files.example.test/downloads/beta.iso#fragment">absolute same directory</a><a href="javascript:alert(1)">script</a><a href="ftp://files.example.test/downloads/file.zip">ftp</a></html>`,
    'https://files.example.test/downloads/'
  )
  expect(links).toEqual([
    'https://files.example.test/downloads/alpha.zip',
    'https://files.example.test/downloads/beta.iso'
  ])
})

test('directory listing import normalizes fragments, deduplicates links, and rejects path-prefix escapes', () => {
  const links = directoryListingLinks(
    '<a href="one.zip#first">first</a><a href="one.zip#second">duplicate</a><a href="%2e%2e/escape.zip">encoded parent</a><a href="https://files.example.test/downloads-evil/escape.zip">prefix escape</a><a href="https://files.example.test/downloads/two.zip?token=a&amp;b=c">query</a>',
    'https://files.example.test/downloads/'
  )
  expect(links).toEqual([
    'https://files.example.test/downloads/one.zip',
    'https://files.example.test/downloads/two.zip?token=a&b=c'
  ])
})

test('directory listing import rejects malformed markup and unsupported URL schemes', () => {
  expect(
    directoryListingLinks(
      '<a href="file:///C:/secret.txt">file</a><a href="data:text/plain,secret">data</a><a href="https://u:p@example.test/private.zip">credentialed</a><a href="https://example.test/unterminated>'
    )
  ).toEqual([])
})

test('directory listing import rejects relative links without a base and rejects credentialed or invalid bases', () => {
  expect(directoryListingLinks('<a href="relative.zip">file</a>')).toEqual([])
  expect(directoryListingLinks('<a href="relative.zip">file</a>', 'file:///C:/downloads/')).toEqual(
    []
  )
  expect(
    directoryListingLinks(
      '<a href="relative.zip">file</a>',
      'https://user:pass@files.example.test/downloads/'
    )
  ).toEqual([])
})
