import { createServer, type Server } from 'node:http'
import { expect, test } from './fixtures'
import { previewSiteMirror } from '../src/main/siteMirror'

async function startSite(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (request.url === '/robots.txt') {
      response.setHeader('Content-Type', 'text/plain')
      response.end('User-agent: *\nDisallow: /private/\n')
      return
    }
    if (request.url === '/') {
      response.end(
        '<a href="/files/a.zip">a</a><a href="/sub/">sub</a><a href="/private/no.zip">private</a><a href="https://outside.invalid/file.zip">external</a><a href="/files/ignore.txt">text</a>'
      )
      return
    }
    if (request.url === '/sub/') {
      response.end('<a href="/files/b.iso">b</a><a href="/">home</a>')
      return
    }
    response.statusCode = 404
    response.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Test server did not bind a TCP port')
  return { server, url: `http://127.0.0.1:${address.port}/` }
}

test('site mirror dry run respects robots, same-origin boundary, depth, file filters and request caps', async () => {
  const site = await startSite()
  try {
    const preview = await previewSiteMirror({
      url: site.url,
      termsConfirmed: true,
      maxDepth: 1,
      maxPages: 5,
      delayMs: 500,
      extensions: ['.zip', '.iso']
    })
    expect(preview.pagesVisited).toBe(2)
    expect(preview.links).toEqual([
      new URL('/files/a.zip', site.url).toString(),
      new URL('/files/b.iso', site.url).toString()
    ])
    expect(preview.blockedByRobots).toBe(1)
    expect(preview.links.some((link) => link.includes('outside.invalid'))).toBe(false)
    expect(preview.links.some((link) => link.endsWith('.txt'))).toBe(false)
  } finally {
    await new Promise<void>((resolve, reject) =>
      site.server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

test('site mirror honors robots wildcard, end-anchor, longest-rule and allow-tie precedence', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.setHeader('Content-Type', 'text/plain')
      response.end(
        [
          'User-agent: otherbot',
          'Disallow: /',
          '',
          'User-agent: *',
          'Disallow: /private/',
          'Disallow: /assets/*.zip$',
          'Allow: /assets/allowed.zip',
          'Disallow: /exact.zip$',
          'Allow: /exact.zip$',
          'Disallow: /encoded/~user/'
        ].join('\r\n')
      )
      return
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(
      '<a href="/private/secret.zip">secret</a><a href="/assets/blocked.zip">blocked</a><a href="/assets/allowed.zip">allowed</a><a href="/assets/readme.txt">readme</a><a href="/exact.zip">exact</a><a href="/exact/child.zip">child</a><a href="/encoded/%7Euser/blocked.zip">encoded blocked</a>'
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Test server did not bind a TCP port')
  const url = `http://127.0.0.1:${address.port}/`
  try {
    const preview = await previewSiteMirror({
      url,
      termsConfirmed: true,
      maxDepth: 0,
      maxPages: 1,
      delayMs: 500,
      extensions: ['.zip', '.txt']
    })
    expect(preview.links).toEqual([
      new URL('/assets/allowed.zip', url).toString(),
      new URL('/assets/readme.txt', url).toString(),
      new URL('/exact.zip', url).toString(),
      new URL('/exact/child.zip', url).toString()
    ])
    expect(preview.blockedByRobots).toBe(3)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

test('site mirror follows same-origin redirects and blocks redirects outside the selected origin', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.setHeader('Content-Type', 'text/plain')
      response.end(`User-agent: *
`)
      return
    }
    if (request.url === '/') {
      response.statusCode = 302
      response.setHeader('Location', '/landing/')
      response.end()
      return
    }
    if (request.url === '/landing/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end('<a href="/file.zip">file</a><a href="/escape/">escape</a>')
      return
    }
    if (request.url === '/escape/') {
      response.statusCode = 302
      response.setHeader('Location', 'http://example.invalid/outside/')
      response.end()
      return
    }
    response.statusCode = 404
    response.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Test server did not bind a TCP port')
  const url = `http://127.0.0.1:${address.port}/`
  try {
    const preview = await previewSiteMirror({
      url,
      termsConfirmed: true,
      maxDepth: 1,
      maxPages: 3,
      delayMs: 500,
      extensions: ['.zip']
    })
    expect(preview.links).toEqual([new URL('/file.zip', url).toString()])
    expect(
      preview.issues.some((issue) => issue.includes('left the selected website boundary'))
    ).toBe(true)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

test('site mirror reports progress and cancels an in-flight page request', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.setHeader('Content-Type', 'text/plain')
      response.end(`User-agent: *
`)
      return
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    const timer = setTimeout(() => response.end('<a href="/files/a.zip">a</a>'), 5000)
    response.on('close', () => clearTimeout(timer))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Test server did not bind a TCP port')
  const url = `http://127.0.0.1:${address.port}/`
  const controller = new AbortController()
  let currentPath = ''
  try {
    const preview = await previewSiteMirror(
      {
        url,
        termsConfirmed: true,
        maxDepth: 0,
        maxPages: 1,
        delayMs: 500,
        extensions: ['.zip']
      },
      {
        signal: controller.signal,
        onProgress: (progress) => {
          currentPath = progress.currentPath
          setTimeout(() => controller.abort(), 50)
        }
      }
    )
    expect(currentPath).toBe('/')
    expect(preview.cancelled).toBe(true)
    expect(preview.links).toEqual([])
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

test('site mirror requires explicit terms confirmation and rejects unsafe limits', async () => {
  await expect(
    previewSiteMirror({
      url: 'https://example.com/',
      termsConfirmed: false,
      maxDepth: 0,
      maxPages: 1,
      delayMs: 500,
      extensions: ['.zip']
    })
  ).rejects.toThrow(/reviewed the website terms/i)
  await expect(
    previewSiteMirror({
      url: 'https://example.com/',
      termsConfirmed: true,
      maxDepth: 99,
      maxPages: 1,
      delayMs: 500,
      extensions: ['.zip']
    })
  ).rejects.toThrow(/depth must be between 0 and 3/i)
})
