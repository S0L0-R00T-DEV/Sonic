import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { BLOCK, expect, interfacesEnv, NETWORKS, PROJECT_ROOT, test, treeSha } from './fixtures'
import { seededBytes } from './origin'
import { named, Swarm, torrentFileOnDisk } from './torrentSwarm'
import { createRuntimeLogBuffer } from '../src/main/runtimeLog'
import { HttpMediaPreviewServer } from '../src/main/download/httpMediaPreview'

const SIZE = 24 * BLOCK

test('primary controls have accessible names and settings are keyboard operable @smoke', async ({
  sonic
}) => {
  const page = sonic.page
  const unnamedButtons = await page.locator('button').evaluateAll((buttons) =>
    buttons
      .filter((button) => {
        const labelledBy = button.getAttribute('aria-labelledby')
        const referencedLabel = labelledBy
          ? (document.getElementById(labelledBy)?.textContent?.trim() ?? '')
          : ''
        return !(
          button.getAttribute('aria-label')?.trim() ||
          button.getAttribute('title')?.trim() ||
          button.textContent?.trim() ||
          referencedLabel
        )
      })
      .map((button) => button.outerHTML.slice(0, 180))
  )
  expect(unnamedButtons).toEqual([])

  const settings = page.getByRole('button', { name: 'Open settings' })
  await settings.focus()
  await expect(settings).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('F-24 performance benchmark captures repeatable per-interface measurements @smoke', async ({
  sonic
}) => {
  const page = sonic.page
  await page.getByRole('button', { name: 'Open settings' }).click()
  await expect(
    page.getByRole('heading', { name: 'Performance diagnostics & benchmark' })
  ).toBeVisible()
  await page.getByLabel('Run mode').selectOption('multi-interface')
  await page.getByRole('button', { name: 'Start capture' }).click()
  await expect(page.getByText(/Baseline captured for multi-interface/)).toBeVisible()
  await page.getByRole('button', { name: 'Finish capture' }).click()
  await expect(page.getByRole('cell', { name: 'Multi-interface', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export results' })).toBeEnabled()
})
test('F-18 HTTP media preview streams only available bytes and waits for the sequential file to grow', async () => {
  const directory = await mkdtemp(join(os.tmpdir(), 'sonic-f18-preview-'))
  const file = join(directory, 'preview.webm')
  await writeFile(file, 'first')
  let availableBytes = 5
  const preview = new HttpMediaPreviewServer(() => ({
    path: file,
    totalBytes: 11,
    availableBytes,
    status: 'downloading',
    contentType: 'video/webm'
  }))
  try {
    const url = await preview.open('test-download')
    const head = await fetch(url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('cache-control')).toBe('no-store')
    expect(head.headers.get('x-content-type-options')).toBe('nosniff')
    const pending = fetch(url, { headers: { Range: 'bytes=0-10' } })
    await new Promise((resolve) => setTimeout(resolve, 250))
    await writeFile(file, 'first world')
    availableBytes = 11
    const response = await pending
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 0-10/11')
    expect(await response.text()).toBe('first world')
    const invalid = await fetch(url, { headers: { Range: 'bytes=99-100' } })
    expect(invalid.status).toBe(416)
    const badMethod = await fetch(url, { method: 'POST' })
    expect(badMethod.status).toBe(405)
  } finally {
    await preview.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('F-18 completed HTTP media conversion requires a matching trusted FFmpeg checksum and produces output', async ({
  sonic
}) => {
  let ffmpegPath: string
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which'
    ffmpegPath =
      execFileSync(command, ['ffmpeg'], { encoding: 'utf8' })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? ''
  } catch {
    test.skip(true, 'FFmpeg is required for the conversion integration test.')
    return
  }
  if (!ffmpegPath) {
    test.skip(true, 'FFmpeg is required for the conversion integration test.')
    return
  }
  const directory = await mkdtemp(join(os.tmpdir(), 'sonic-f18-conversion-'))
  const source = join(directory, 'source.mp4')
  const destination = sonic.dirs.dest
  let mediaBytes = Buffer.alloc(0)
  const server = createServer((request, response) => {
    response.writeHead(200, {
      'Content-Length': mediaBytes.length,
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'attachment; filename="sample.mp4"'
    })
    if (request.method === 'HEAD') response.end()
    else response.end(mediaBytes)
  })
  try {
    execFileSync(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=64x64:d=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        '-shortest',
        '-y',
        source
      ],
      { timeout: 30000, stdio: 'ignore' }
    )
    mediaBytes = await readFile(source)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Conversion test server failed to bind.')
    const downloadId = await sonic.start(
      `http://127.0.0.1:${address.port}/sample.mp4`,
      createHash('sha256').update(mediaBytes).digest('hex'),
      { fileName: 'sample.mp4', connections: 1, destinationDir: destination }
    )
    await sonic.waitUntil((state) => state.id === downloadId && state.status === 'completed', 20000)

    const ffmpegHash = createHash('sha256')
      .update(await readFile(ffmpegPath))
      .digest('hex')
    const wrongHashResult = await sonic.page.evaluate(
      async ({ id, ffmpegPath, outputDir }) => {
        try {
          await window.sonic.startMediaConversion(id, {
            ffmpegPath,
            expectedSha256: '0'.repeat(64),
            outputDir,
            format: 'webm'
          })
          return 'started'
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
      { id: downloadId, ffmpegPath, outputDir: directory }
    )
    expect(wrongHashResult).toContain('does not match')

    const result = await sonic.page.evaluate(
      async ({ id, ffmpegPath, expectedSha256, outputDir }) => {
        let operationId = ''
        const terminal = new Promise<import('../src/shared/types').MediaConversionProgress>(
          (resolve, reject) => {
            const off = window.sonic.onMediaConversionProgress((event) => {
              if (event.operationId === operationId && event.status !== 'running') {
                off()
                resolve(event)
              }
            })
            setTimeout(() => {
              off()
              reject(new Error('Timed out waiting for conversion result.'))
            }, 30000)
          }
        )
        operationId = await window.sonic.startMediaConversion(id, {
          ffmpegPath,
          expectedSha256,
          outputDir,
          format: 'webm'
        })
        return terminal
      },
      { id: downloadId, ffmpegPath, expectedSha256: ffmpegHash, outputDir: directory }
    )
    expect(result.status).toBe('completed')
    expect(result.outputPath).toMatch(/\.webm$/i)
    expect((await stat(result.outputPath!)).size).toBeGreaterThan(0)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

test('F-19 custom tags and automatic destination rules are configurable and persist @smoke', async ({
  sonic
}) => {
  const page = sonic.page
  await page.getByRole('button', { name: 'Tags & rules' }).click()
  const dialog = page.getByRole('dialog', { name: 'Tags & automatic destinations' })
  await expect(dialog).toBeVisible()
  const tags = dialog.getByRole('textbox', { name: /Comma-separated tag names/i })
  await tags.fill('Documents, Games, QA')
  await dialog.getByRole('button', { name: 'Add rule' }).click()
  await dialog.getByRole('textbox', { name: 'Rule 1 match value' }).fill('.pdf')
  const downloadsDir = await page.evaluate(
    () => window.sonic.initialState.destinationDir ?? window.sonic.initialState.downloadsDir
  )
  const destination = await mkdtemp(join(os.tmpdir(), 'sonic-f19-destination-'))
  const domainDestination = await mkdtemp(join(os.tmpdir(), 'sonic-f19-domain-'))
  const manualDestination = await mkdtemp(join(os.tmpdir(), 'sonic-f19-manual-'))
  const body = Buffer.from('%PDF-1.4\nF-19 destination routing test\n%%EOF\n')
  const server = createServer((request, response) => {
    response.writeHead(200, {
      'Content-Length': body.length,
      'Content-Type': 'application/pdf',
      'Accept-Ranges': 'none'
    })
    if (request.method === 'HEAD') response.end()
    else response.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('F-19 fixture server failed to bind.')
  try {
    await dialog.getByRole('textbox', { name: 'Rule 1 destination folder' }).fill(destination)
    await dialog.getByRole('button', { name: 'Add rule' }).click()
    await dialog.getByRole('combobox', { name: 'Rule 2 match type' }).selectOption('domain')
    await dialog.getByRole('textbox', { name: 'Rule 2 match value' }).fill('127.0.0.1')
    await dialog.getByRole('textbox', { name: 'Rule 2 destination folder' }).fill(domainDestination)
    await dialog.getByRole('button', { name: 'Save organization settings' }).click()
    await expect(dialog).toHaveCount(0)
    await page.getByRole('button', { name: 'Tags & rules' }).click()
    const reopened = page.getByRole('dialog', { name: 'Tags & automatic destinations' })
    await expect(reopened.getByRole('textbox', { name: /Comma-separated tag names/i })).toHaveValue(
      'Documents, Games, QA'
    )
    await expect(reopened.getByRole('textbox', { name: 'Rule 1 match value' })).toHaveValue('.pdf')
    await expect(reopened.getByRole('textbox', { name: 'Rule 1 destination folder' })).toHaveValue(
      destination
    )
    await expect(reopened.getByRole('combobox', { name: 'Rule 2 match type' })).toHaveValue(
      'domain'
    )
    await expect(reopened.getByRole('textbox', { name: 'Rule 2 match value' })).toHaveValue(
      '127.0.0.1'
    )
    await expect(reopened.getByRole('textbox', { name: 'Rule 2 destination folder' })).toHaveValue(
      domainDestination
    )
    await page.keyboard.press('Escape')

    // Exercise the real IPC start path, not just the rule editor: default destinations should be rerouted.
    const id = await page.evaluate(
      async ({ url, defaultDir }) =>
        window.sonic.startDownload({
          kind: 'http',
          url,
          destinationDir: defaultDir,
          suggestedFileName: 'route.pdf',
          totalBytes: 0,
          supportsRanges: false,
          interfaceIds: [],
          etag: null,
          lastModified: null
        }),
      { url: `http://127.0.0.1:${address.port}/source.bin`, defaultDir: downloadsDir }
    )
    const output = join(destination, 'route.pdf')
    await expect
      .poll(
        async () => {
          try {
            return await readFile(output, 'utf8')
          } catch {
            return null
          }
        },
        { timeout: 20000 }
      )
      .toBe(body.toString('utf8'))
    expect(id).toBeTruthy()

    const domainId = await page.evaluate(
      async ({ url, defaultDir }) =>
        window.sonic.startDownload({
          kind: 'http',
          url,
          destinationDir: defaultDir,
          suggestedFileName: 'domain.bin',
          totalBytes: 0,
          supportsRanges: false,
          interfaceIds: [],
          etag: null,
          lastModified: null
        }),
      { url: `http://127.0.0.1:${address.port}/domain.bin`, defaultDir: downloadsDir }
    )
    const domainOutput = join(domainDestination, 'domain.bin')
    await expect
      .poll(
        async () => {
          try {
            return await readFile(domainOutput, 'utf8')
          } catch {
            return null
          }
        },
        { timeout: 20000 }
      )
      .toBe(body.toString('utf8'))
    expect(domainId).toBeTruthy()
    const manualId = await page.evaluate(
      async ({ url, explicitDir }) =>
        window.sonic.startDownload({
          kind: 'http',
          url,
          destinationDir: explicitDir,
          suggestedFileName: 'manual.pdf',
          totalBytes: 0,
          supportsRanges: false,
          interfaceIds: [],
          etag: null,
          lastModified: null
        }),
      { url: `http://127.0.0.1:${address.port}/manual.bin`, explicitDir: manualDestination }
    )
    const manualOutput = join(manualDestination, 'manual.pdf')
    await expect
      .poll(
        async () => {
          try {
            return await readFile(manualOutput, 'utf8')
          } catch {
            return null
          }
        },
        { timeout: 20000 }
      )
      .toBe(body.toString('utf8'))
    expect(manualId).toBeTruthy()

    // Tag assignment is attached to download IDs, shown in rows, and included in list search.
    const routeSelection = page.getByRole('checkbox', { name: 'Select route.pdf' })
    await expect(routeSelection).toBeVisible()
    await routeSelection.click()
    await page.getByRole('button', { name: 'Tags', exact: true }).click()
    const tagDialog = page.getByRole('dialog', { name: 'Tags & automatic destinations' })
    await tagDialog.getByRole('checkbox', { name: 'Documents' }).check()
    await tagDialog.getByRole('button', { name: 'Save organization settings' }).click()
    await expect(page.getByText('Documents', { exact: true })).toBeVisible()
    await page.getByRole('searchbox', { name: 'Search downloads' }).fill('Documents')
    await expect(page.getByText('route.pdf', { exact: true })).toBeVisible()
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    await rm(destination, { recursive: true, force: true })
    await rm(domainDestination, { recursive: true, force: true })
    await rm(manualDestination, { recursive: true, force: true })
  }
})

test('F-20 axe-core WCAG 2.2 AA audit of the primary screen and settings @smoke', async ({
  sonic
}) => {
  await sonic.page.addScriptTag({
    url: pathToFileURL(join(PROJECT_ROOT, 'node_modules', 'axe-core', 'axe.min.js')).href
  })
  const audit = async (state: string): Promise<void> => {
    const results = await sonic.page.evaluate(async () => {
      const axe = (
        window as unknown as Window & {
          axe: {
            run: (
              context: Document,
              options: { runOnly: { type: 'tag'; values: string[] } }
            ) => Promise<{
              violations: Array<{
                id: string
                impact: string | null
                help: string
                nodes: Array<{ target: string[]; failureSummary: string | null }>
              }>
            }>
          }
        }
      ).axe
      return axe.run(document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
        }
      })
    })
    const findings = results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary }))
    }))
    console.log(`F-20 axe-core findings (${state}): ${JSON.stringify(findings, null, 2)}`)
    expect(
      results.violations.filter(
        (violation) => violation.impact === 'critical' || violation.impact === 'serious'
      ),
      `${state} should have no serious or critical automated WCAG violations`
    ).toEqual([])
  }

  await audit('primary screen')
  await sonic.page.getByRole('button', { name: 'Open settings' }).click()
  await expect(sonic.page.getByRole('dialog')).toBeVisible()
  await audit('settings dialog')
  await sonic.page.keyboard.press('Escape')
  await expect(sonic.page.getByRole('dialog')).toHaveCount(0)

  await sonic.newDownload()
  await expect(sonic.page.getByRole('dialog')).toBeVisible()
  await audit('new download dialog')
  await sonic.page.keyboard.press('Escape')
  await expect(sonic.page.getByRole('dialog')).toHaveCount(0)

  await sonic.page.getByRole('button', { name: 'Import links' }).click()
  await expect(sonic.page.getByRole('dialog')).toBeVisible()
  await audit('batch import dialog')
  await sonic.page.keyboard.press('Escape')
  await expect(sonic.page.getByRole('dialog')).toHaveCount(0)

  await sonic.page.getByRole('button', { name: /network/i }).click()
  await expect(sonic.page.getByText('Active networks')).toBeVisible()
  await audit('active networks menu')
  await sonic.page.getByRole('button', { name: 'Edit network' }).first().click()
  await expect(sonic.page.getByRole('textbox', { name: 'Name' })).toBeVisible()
  await audit('network editor')
})

test('application transfer benchmark produces a repeatable baseline @benchmark', async ({
  sonic,
  serve
}) => {
  const size = 16 * 1024 * 1024
  const repetitions = 3
  const appVersion = await sonic.evaluateMain(({ app }) => app.getVersion(), null)
  const records: Array<{
    repetition: number
    bytes: number
    sha256: string
    elapsedMs: number
    throughputMiBPerSecond: number
    queueRenderMs: number
    systemLoadCondition: 'baseline' | 'controlled-cpu-load'
    mainProcessPeakRssBytes: number
    mainProcessPeakHeapBytes: number
    mainProcessCpuMs: number
    requests: number
  }> = []

  for (let repetition = 1; repetition <= repetitions; repetition++) {
    // A fresh Electron process for each sample prevents prior renderer/main-process state from
    // silently accumulating across repetitions. The user-data directory remains the same.
    if (repetition > 1) await sonic.relaunch()
    const systemLoadCondition = repetition === 2 ? 'controlled-cpu-load' : 'baseline'
    let loadProcess: ChildProcess | undefined
    if (systemLoadCondition === 'controlled-cpu-load') {
      // Deliberately occupy one logical CPU during this sample; bounded duration is a fail-safe.
      loadProcess = spawn(
        process.execPath,
        ['-e', 'const end=Date.now()+20000; while(Date.now()<end){}'],
        {
          stdio: 'ignore',
          windowsHide: true
        }
      )
    }
    const origin = await serve({ size, seed: 2026, sharedBytesPerSecond: 8 * 1024 * 1024 })
    const baseline = await sonic.evaluateMain(
      () => ({
        rss: process.memoryUsage().rss,
        heap: process.memoryUsage().heapUsed,
        cpu: process.cpuUsage()
      }),
      null
    )
    let peakRss = baseline.rss
    let peakHeap = baseline.heap
    const startedAt = performance.now()
    const queueStartedAt = performance.now()
    const fileName = `sonic-benchmark-${repetition}.bin`
    const id = await sonic.start(origin.url(), origin.sha256, {
      fileName,
      connections: 2
    })
    await expect(
      sonic.page.getByRole('button', { name: `Open ${fileName}`, exact: true })
    ).toBeVisible({ timeout: 10_000 })
    const queueRenderMs = Math.round((performance.now() - queueStartedAt) * 100) / 100
    let state = await sonic.byId(id)
    const deadline = Date.now() + 90_000
    while (state?.status !== 'completed' && Date.now() < deadline) {
      const sample = await sonic.evaluateMain(
        () => ({
          rss: process.memoryUsage().rss,
          heap: process.memoryUsage().heapUsed
        }),
        null
      )
      peakRss = Math.max(peakRss, sample.rss)
      peakHeap = Math.max(peakHeap, sample.heap)
      await new Promise((resolve) => setTimeout(resolve, 100))
      state = await sonic.byId(id)
      if (state?.status === 'error' || state?.status === 'cancelled') {
        throw new Error(
          `Benchmark download ${repetition} ended ${state.status}: ${state.error ?? 'no error detail'}`
        )
      }
    }
    expect(state?.status, `benchmark repetition ${repetition} completes`).toBe('completed')
    if (loadProcess && loadProcess.exitCode === null) loadProcess.kill()
    const after = await sonic.evaluateMain(
      () => ({
        rss: process.memoryUsage().rss,
        heap: process.memoryUsage().heapUsed,
        cpu: process.cpuUsage()
      }),
      null
    )
    peakRss = Math.max(peakRss, after.rss)
    peakHeap = Math.max(peakHeap, after.heap)
    const elapsedMs = performance.now() - startedAt
    const cpuUs = after.cpu.user - baseline.cpu.user + after.cpu.system - baseline.cpu.system
    records.push({
      repetition,
      bytes: size,
      sha256: origin.sha256,
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      throughputMiBPerSecond: Math.round((size / (elapsedMs / 1000) / (1024 * 1024)) * 1000) / 1000,
      queueRenderMs,
      systemLoadCondition,
      mainProcessPeakRssBytes: peakRss,
      mainProcessPeakHeapBytes: peakHeap,
      mainProcessCpuMs: Math.round(cpuUs / 1000),
      requests: origin.log.length
    })
  }

  const sorted = records.map((record) => record.throughputMiBPerSecond).sort((a, b) => a - b)
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    appVersion,
    benchmark: 'local deterministic HTTP transfer through the real Electron task manager',
    limitations: [
      'Local loopback workload; not an Internet or competitor benchmark.',
      'Elapsed time includes URL probe and task-start overhead for every repetition.',
      'Queue-render latency measures start-call to visible queue row, not paint-to-photon latency.',
      'The controlled-load sample runs one bounded CPU-burner child process; it is a synthetic stress condition, not a general system-load profile.',
      'Memory samples cover the Electron main process only, not all Chromium child processes.'
    ],
    environment: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      nodeVersion: process.version,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem()
    },
    configuration: {
      payloadBytes: size,
      sha256: records[0].sha256,
      sourceRateBytesPerSecond: 8 * 1024 * 1024,
      connectionsPerDownload: 2,
      repetitions
    },
    summary: {
      medianThroughputMiBPerSecond: sorted[Math.floor(sorted.length / 2)],
      minThroughputMiBPerSecond: sorted[0],
      maxThroughputMiBPerSecond: sorted.at(-1),
      medianQueueRenderMs: (() => {
        const values = records.map((record) => record.queueRenderMs).sort((a, b) => a - b)
        return values[Math.floor(values.length / 2)]
      })(),
      throughputBySystemLoad: {
        baselineMeanMiBPerSecond: (() => {
          const values = records
            .filter((record) => record.systemLoadCondition === 'baseline')
            .map((record) => record.throughputMiBPerSecond)
          return (
            Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) /
            1000
          )
        })(),
        controlledCpuLoadMiBPerSecond:
          records.find((record) => record.systemLoadCondition === 'controlled-cpu-load')
            ?.throughputMiBPerSecond ?? null
      }
    },
    records
  }
  await writeFile(
    join(PROJECT_ROOT, 'diagnostics', 'sonic-app-benchmark-latest.json'),
    JSON.stringify(report, null, 2) + '\n',
    'utf8'
  )
  console.log('SONIC_APP_BENCHMARK', JSON.stringify(report))
  expect(records).toHaveLength(repetitions)
  expect(new Set(records.map((record) => record.sha256)).size).toBe(1)
})

test('runtime log collector redacts sensitive data and enforces its bounds', () => {
  const logs = createRuntimeLogBuffer({ maxEntries: 2, maxChars: 1000, maxEntryChars: 300 })
  logs.append(
    'error',
    new Error(
      'GET https://example.test/file?token=secret failed at C:\\\\Users\\\\TS07\\\\Downloads\\\\test.bin'
    )
  )
  logs.append('warn', {
    cookie: 'sid=top-secret',
    authorization: 'Bearer another-secret',
    detail:
      'token=secret https://example.test/private C:\\\\Users\\\\TS07\\\\Downloads\\\\sample.bin'
  })
  logs.append('info', 'safe final event')

  const snapshot = logs.snapshot()
  const serialized = JSON.stringify(snapshot)
  expect(snapshot.entries).toHaveLength(2)
  expect(snapshot.truncated).toBe(true)
  expect(snapshot.entries.map((entry) => entry.level)).toEqual(['warn', 'info'])
  expect(serialized).not.toContain('example.test')
  expect(serialized).not.toContain('TS07')
  expect(serialized).not.toContain('top-secret')
  expect(serialized).not.toContain('another-secret')
  expect(serialized).not.toContain('sid=')
  expect(serialized).not.toContain('token=secret')
})

/** Native destination-picker and file-reveal dialogs are stubbed for deterministic E2E coverage. */
async function stubDiagnosticSaveDialog(
  sonic: import('./fixtures').SonicApp,
  filePath: string
): Promise<void> {
  await sonic.evaluateMain(({ dialog }, destination) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: destination })) as never
  }, filePath)
}

async function stubNativeUi(
  sonic: import('./fixtures').SonicApp,
  destination: string
): Promise<void> {
  await sonic.evaluateMain(({ dialog, shell }, dest) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dest] })) as never
    const revealed: string[] = []
    ;(globalThis as Record<string, unknown>).__revealed = revealed
    shell.showItemInFolder = (path: string) => void revealed.push(path)
  }, destination)
}

test('Show in Finder on a download in progress shows its staging file', async ({
  sonic,
  serve,
  dirs
}) => {
  const origin = await serve({ size: SIZE })
  await stubNativeUi(sonic, dirs.dest)
  const reached = origin.hold(6 * BLOCK)
  const id = await sonic.start(origin.url(), origin.sha256)
  await reached
  const { destinationPath } = (await sonic.api.listDownloads()).find(
    (entry) => entry.state.id === id
  )!.state
  // The final file isn't there yet: what's on disk is `<name>.sonic`.
  expect(await sonic.api.revealDownload(id)).toBe(true)
  expect(
    await sonic.evaluateMain(() => (globalThis as Record<string, unknown>).__revealed, null)
  ).toEqual([`${destinationPath}.sonic`])
  origin.release()
})

test.describe('a torrent through the UI', () => {
  // This journey inspects a peer row, not network reassignment. Keep one network stable;
  // routing across networks and globally unique peer IDs are checked by torrent specs/invariants.
  test.use({ appEnv: { SONIC_E2E_INTERFACES: interfacesEnv({ a: NETWORKS.a }) } })
  test('choose its files, watch its peers, finish', async ({ sonic, dirs }) => {
    const swarm = await new Swarm().start()
    try {
      const files = ['a.bin', 'b.bin', 'c.bin'].map((name, index) =>
        named(seededBytes(1024 * 1024, 81 + index), name)
      )
      // Two seeders, slow enough to look at the download while it runs.
      const options = { folder: 'Trio', pieceLength: 64 * 1024, uploadLimit: 200 * 1024 }
      await swarm.seed(files, options)
      const torrent = await swarm.seed(files, options)
      await stubNativeUi(sonic, dirs.dest)
      const page = sonic.page

      const link = await sonic.newDownload()
      await page.getByRole('button', { name: 'Change' }).click()
      await link.fill(await torrentFileOnDisk(torrent))
      const bFile = page.getByRole('checkbox', { name: /b\.bin/ })
      await bFile.focus()
      await expect(bFile).toBeFocused()
      await page.keyboard.press('Space')
      await expect(bFile).not.toBeChecked()
      await sonic.expectNextDownload(
        treeSha(
          [files[0], files[2]].map((data) => ({ path: (data as { name?: string }).name!, data }))
        )
      )
      // Started: its own screen opens.
      await page.getByRole('button', { name: 'Download' }).click()

      // Running: its connections are peers, and its blocks pieces.
      const peers = page.getByRole('button', { name: /^\d+ peers?/ }).first()
      await expect(peers).toBeVisible()
      await peers.click()
      // Numbered by connection, so whichever peers are connected now.
      const peerRow = page
        .getByRole('row')
        .filter({ hasText: /Peer #\d+/ })
        .first()
      await expect(peerRow).toBeVisible()
      // Only what isn't the usual gets a word: no badge for a peer that's sending.
      await expect(peerRow).not.toContainText(/RECEIVING|CONNECTED|ACTIVE/)
      await expect(peerRow).not.toContainText('Peer connection')
      // Its share of what its network's peers have sent.
      await expect(peerRow).toContainText(/\d+%/)
      // Read out in words, not only shown as an arrow; upload only once something was sent.
      await expect(peerRow).toContainText('Receiving at')
      await expect(peerRow).not.toContainText('Sending at')
      await expect(peerRow.getByRole('cell')).toHaveCount(6)
      // What it runs. A peer has no progress of its own: a dash, not a bar.
      await expect(peerRow).toContainText('WebTorrent')
      await expect(peerRow.getByRole('progressbar')).toHaveCount(0)
      // Each rendered peer has its own number.
      const numbers = (await page.getByText(/^Peer #\d+$/).allTextContents()).map((text) =>
        text.trim()
      )
      expect(numbers.length).toBeGreaterThan(0)
      expect(new Set(numbers).size).toBe(numbers.length)
      const networks = page.getByRole('table', { name: 'Networks' })
      await expect(networks.getByRole('columnheader', { name: 'Verified' })).toHaveCount(0)
      await expect(
        networks.getByRole('columnheader', { name: 'Progress', exact: true })
      ).toBeVisible()
      await expect(networks.getByRole('progressbar').first()).toBeVisible()
      await expect(
        page.getByRole('progressbar', { name: 'Download progress', exact: true })
      ).toHaveCount(0)
      await expect(peerRow).not.toContainText(/Piece #/)
      await expect(page.getByText(/^\d+ pieces · /)).toBeVisible()
      // Each network's upload, even before anything is sent; nothing at the top. A peer that has
      // sent nothing carries no upload line, and no arrows: a lone download figure needs none.
      await expect(page.getByText(/^UP \d/)).toHaveCount(0)
      await expect(networks.getByText(/Uploading at/).first()).toBeAttached()
      // Avoid leaking common UTF-8 decoding artifacts into the peer table.
      await expect(peerRow).not.toContainText(/\u00c3\u00a2|\u00e2\u20ac|\ufffd/)

      // Done: two of its three files, with what fetched them.
      await expect(page.getByRole('button', { name: /Show in (Finder|folder)/ })).toBeVisible({
        timeout: 60_000
      })
      await expect(page.getByText(/^2 of 3 files · /)).toBeVisible()
      await expect(page.getByText('Peers', { exact: true })).toBeVisible()
      await expect(page.getByText(/^written in \d+ pieces · uploaded /)).toBeVisible()
    } finally {
      await swarm.stop()
    }
  })
})

test.describe('UI journeys @smoke', () => {
  test('per-download receive limit persists and caps the transfer', async ({
    sonic,
    serve,
    dirs
  }) => {
    const size = 4 * 1024 * 1024
    const origin = await serve({ size })
    const held = origin.hold(BLOCK)
    const id = await sonic.start(origin.url(), origin.sha256)
    await held

    const page = sonic.page
    await page.getByRole('button', { name: 'Open test.bin', exact: true }).click()
    const cap = page.getByRole('combobox', { name: 'Download receive speed limit' })
    await expect(cap).toBeVisible()
    await cap.selectOption(String(512 * 1024))
    await expect
      .poll(async () => (await sonic.byId(id))?.maxDownloadSpeedBytesPerSecond)
      .toBe(512 * 1024)

    const manifestPath = join(dirs.userData, 'downloads', id, 'manifest.json')
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(manifestPath, 'utf-8')).state.maxDownloadSpeedBytesPerSecond
      )
      .toBe(512 * 1024)

    const releasedAt = Date.now()
    origin.release()
    await sonic.waitForHttpStatus('completed')
    // With nearly 4 MiB remaining, a 512 KiB/s task cap should take several seconds. Use a
    // generous lower bound so this guards against a limiter that is merely cosmetic in the UI.
    expect(Date.now() - releasedAt).toBeGreaterThan(2500)
  })

  test('warns before adding the same link twice but permits an intentional duplicate', async ({
    sonic,
    serve
  }) => {
    const origin = await serve({ size: 10 * BLOCK })
    const held = origin.hold(BLOCK)
    const id = await sonic.start(origin.url(), origin.sha256)
    await held
    await sonic.api.pauseDownload(id)

    const page = sonic.page
    const link = await sonic.newDownload()
    const dialog = page.getByRole('dialog', { name: 'New download' })
    await expect(dialog).toBeVisible()
    await link.fill(origin.url())
    await expect(dialog.getByRole('status')).toContainText('already paused as test.bin')
    await expect(dialog.getByRole('button', { name: 'Download' })).toBeEnabled()
  })
  test('moves a queued download to the front without losing its partial progress', async ({
    sonic,
    serve
  }) => {
    await sonic.api.updateSettings({ downloadsAtOnce: 1 })
    const first = await serve({ size: 10 * BLOCK, seed: 1 })
    const second = await serve({ size: 10 * BLOCK, seed: 2 })
    const third = await serve({ size: 10 * BLOCK, seed: 3 })
    const held = first.hold(BLOCK)
    // Keep the next two servers blocked as well, so the queue-order assertions cannot race
    // through their downloads while the test is inspecting the scheduler.
    const heldSecond = second.hold(BLOCK)
    const heldThird = third.hold(BLOCK)
    const firstId = await sonic.start(first.url(), first.sha256, { fileName: 'first.bin' })
    await held
    const secondId = await sonic.start(second.url(), second.sha256, { fileName: 'second.bin' })
    const thirdId = await sonic.start(third.url(), third.sha256, { fileName: 'third.bin' })
    await expect.poll(async () => (await sonic.byId(secondId))?.status).toBe('queued')
    await expect.poll(async () => (await sonic.byId(thirdId))?.status).toBe('queued')
    const savedProgress = (await sonic.byId(secondId))?.bytesDownloaded ?? 0

    // Right-click the uniquely labelled row action to avoid matching the row, pause button,
    // and open-details button simultaneously.
    await sonic.page.getByRole('button', { name: 'Open second.bin' }).click({ button: 'right' })
    await sonic.page.getByRole('menuitem', { name: 'Move to front of queue' }).click()
    await expect.poll(async () => (await sonic.byId(secondId))?.status).toBe('queued')
    expect((await sonic.byId(secondId))?.queuedAt).toBeLessThan(
      (await sonic.byId(thirdId))?.queuedAt ?? Number.POSITIVE_INFINITY
    )
    expect((await sonic.byId(secondId))?.bytesDownloaded).toBe(savedProgress)

    first.release()
    await expect.poll(async () => (await sonic.byId(firstId))?.status).toBe('completed')
    await heldSecond
    await expect.poll(async () => (await sonic.byId(secondId))?.status).toBe('downloading')
    expect((await sonic.byId(thirdId))?.status).toBe('queued')
    second.release()
    await expect.poll(async () => (await sonic.byId(secondId))?.status).toBe('completed')
    await heldThird
    await expect.poll(async () => (await sonic.byId(thirdId))?.status).toBe('downloading')
    third.release()
    await expect.poll(async () => (await sonic.byId(thirdId))?.status).toBe('completed')
  })

  test('failure screen explains next steps and exports a sanitized report with save-error recovery', async ({
    sonic,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: 8 * BLOCK })
    const held = origin.hold(BLOCK)
    const id = await sonic.start(origin.url(), origin.sha256)
    await held
    origin.setRule(() => ({ status: 500 }))
    origin.release()
    const failed = await sonic.waitUntil((state) => state.status === 'error', 30_000)
    expect(failed.id).toBe(id)

    const page = sonic.page
    // Error state is shown in the queue until the user opens the failed task details.
    await page.getByRole('button', { name: 'Open test.bin' }).click()
    await expect(page.getByRole('alert')).toContainText('Download failed')
    await expect(page.getByText('What happens next')).toBeVisible()
    await expect(page.getByText('Automatic retry is not scheduled.')).toBeVisible()
    await expect(page.getByText(/network retries recorded/)).toBeVisible()
    await page.getByRole('button', { name: 'Copy diagnostic details' }).click()
    await expect(page.getByRole('button', { name: 'Diagnostics copied' })).toBeVisible()

    // Exercise the real IPC handler and disk write. First force an ENOENT, then retry to a
    // valid destination and inspect the exact JSON file produced by the main process.
    await stubDiagnosticSaveDialog(sonic, join(dirs.userData, 'missing-folder', 'report.json'))
    await page.getByRole('button', { name: /Export diagnostic report/ }).click()
    await expect(page.getByText(/Could not save the diagnostic report/)).toBeVisible()

    const reportPath = join(dirs.userData, 'sonic-diagnostics.json')
    await stubDiagnosticSaveDialog(sonic, reportPath)
    await page.getByRole('button', { name: /Export diagnostic report/ }).click()
    await expect(page.getByRole('button', { name: 'Report saved' })).toBeVisible()

    const reportText = await readFile(reportPath, 'utf8')
    const report = JSON.parse(reportText) as {
      capture: { applicationVersion: string; electronVersion: string; nodeVersion: string }
      runtimeLogs: { entries: unknown[]; truncated: boolean }
      task: { status: string }
    }
    expect(report.capture.applicationVersion).toBe('2.6.0')
    expect(report.capture.electronVersion).not.toBe('unknown')
    expect(report.capture.nodeVersion).not.toBe('unknown')
    expect(report.runtimeLogs.entries).toBeInstanceOf(Array)
    expect(report.task.status).toBe('error')
    expect(reportText).not.toContain('127.0.0.1')
    expect(reportText).not.toContain('sonic-e2e-')
    expect(reportText).not.toContain('Bearer ')
    expect(reportText).not.toMatch(/Bearer\\s+[A-Za-z0-9._-]+/i)
  })

  test('batch import validates link lists without starting invalid entries', async ({ sonic }) => {
    const page = sonic.page
    await page.getByRole('button', { name: 'Import links' }).click()
    const dialog = page.getByRole('dialog', { name: 'Import multiple downloads' })
    await expect(dialog).toBeVisible()
    await page
      .getByRole('textbox', { name: 'Download links, one per line' })
      .fill('ftp://example.com/file.zip\nnot-a-url\n# ignored comment')
    await page.getByRole('button', { name: 'Preview links' }).click()
    await expect(dialog.getByRole('status')).toContainText('No valid links to preview.')
    await expect(dialog).toContainText('Unsupported or invalid link')
    expect(await sonic.api.listDownloads()).toHaveLength(0)
    await dialog.getByRole('button', { name: 'Close import' }).click()
  })

  test('batch import preserves case-sensitive paths and skips fragment-only duplicates', async ({
    sonic,
    serve
  }) => {
    const origin = await serve({ size: 2 * BLOCK })
    const upper = origin.url('/files/Case.bin')
    const lower = origin.url('/files/case.bin')
    const page = sonic.page
    await page.getByRole('button', { name: 'Import links' }).click()
    const dialog = page.getByRole('dialog', { name: 'Import multiple downloads' })
    await dialog
      .getByRole('textbox', { name: 'Download links, one per line' })
      .fill(`${upper}\n${lower}\n${upper}#mirror-fragment`)
    await dialog.getByRole('button', { name: 'Preview links' }).click()
    await expect(dialog.getByRole('status')).toContainText(
      'Preview ready: 2 selectable · Failed 0 · Skipped duplicates 1'
    )
    await expect(dialog).toContainText('Case.bin · HTTP')
    await expect(dialog).toContainText('case (1).bin · HTTP')
    await dialog.getByRole('button', { name: 'Add selected to queue' }).click()
    await expect(dialog.getByRole('status')).toContainText(
      'Added 2 · Failed 0 · Skipped duplicates 1'
    )
    await expect(dialog).toContainText('Added to queue · Case.bin')
    await expect(dialog).toContainText('Added to queue · case (1).bin')
    await expect(dialog).toContainText('Package 127.0.0.1')
    await dialog.getByRole('button', { name: 'Close import' }).click()
  })

  test('batch import retries an unresolved link and recovers its package metadata', async ({
    sonic
  }) => {
    let available = false
    const server = createServer((_request, response) => {
      if (!available) {
        response.writeHead(503, { 'Content-Length': '0' }).end()
        return
      }
      const body = Buffer.from('retryable batch fixture')
      response.writeHead(200, {
        'Content-Length': String(body.length),
        'Content-Disposition': 'attachment; filename="retry.bin"',
        ETag: '"batch-retry"',
        'Accept-Ranges': 'bytes'
      })
      response.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Retry fixture failed to bind.')
    try {
      const page = sonic.page
      await page.getByRole('button', { name: 'Import links' }).click()
      const dialog = page.getByRole('dialog', { name: 'Import multiple downloads' })
      await dialog
        .getByRole('textbox', { name: 'Download links, one per line or pasted text' })
        .fill(`http://127.0.0.1:${address.port}/retry.bin`)
      await dialog.getByRole('button', { name: 'Preview links' }).click()
      await expect(dialog.getByRole('status')).toContainText(
        'Preview ready: 0 selectable · Failed 1'
      )
      await expect(dialog.getByRole('button', { name: 'Retry failed checks' })).toBeVisible()
      available = true
      await dialog.getByRole('button', { name: 'Retry failed checks' }).click()
      await expect(dialog.getByRole('status')).toContainText(
        'Retry complete: 1 recovered · 0 still unresolved'
      )
      await expect(dialog).toContainText('retry.bin · HTTP')
      await expect(dialog).toContainText('Package 127.0.0.1')
      await dialog.getByRole('button', { name: 'Close import' }).click()
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  test('batch import extracts links from HTML and queues only selected preview rows', async ({
    sonic,
    serve
  }) => {
    const first = await serve({ size: BLOCK })
    const second = await serve({ size: 2 * BLOCK })
    const page = sonic.page
    await page.getByRole('button', { name: 'Import links' }).click()
    const dialog = page.getByRole('dialog', { name: 'Import multiple downloads' })
    await dialog
      .getByRole('textbox', { name: 'Download links, one per line or pasted text' })
      .fill(
        `<html><a href="${first.url('/selected.bin')}">First</a><a href="${second.url('/other.zip')}">Second</a></html>`
      )
    await dialog.getByRole('button', { name: 'Preview links' }).click()
    await expect(dialog.getByRole('status')).toContainText('Preview ready: 2 selectable')
    await expect(dialog).toContainText('selected.bin · HTTP')
    await expect(dialog).toContainText('other.zip · HTTP')
    await dialog.getByRole('checkbox', { name: 'Select selected.bin' }).uncheck()
    await dialog.getByRole('button', { name: 'Add selected to queue' }).click()
    await expect(dialog.getByRole('status')).toContainText(
      'Added 1 · Failed 0 · Skipped duplicates 0'
    )
    await expect(dialog).toContainText('Added to queue · other.zip')
    await expect(dialog).not.toContainText('Added to queue · selected.bin')
    await dialog.getByRole('button', { name: 'Close import' }).click()
  })

  for (const scaleFactor of [1, 1.25, 1.5]) {
    test.describe(`GPU compositing diagnostics at ${scaleFactor}x scale`, () => {
      test.use({
        appEnv: {
          SONIC_E2E_GPU: '1',
          SONIC_E2E_DEVICE_SCALE_FACTOR: String(scaleFactor)
        }
      })

      test('active window survives resize, minimize, and restore', async ({ sonic }) => {
        const gpu = await sonic.evaluateMain(
          ({ app }) => ({
            hardwareAcceleration: app.isHardwareAccelerationEnabled(),
            featureStatus: app.getGPUFeatureStatus(),
            scaleFactor: app.commandLine.getSwitchValue('force-device-scale-factor')
          }),
          null
        )
        expect(gpu.hardwareAcceleration).toBe(true)
        expect(gpu.scaleFactor).toBe(String(scaleFactor))

        const window = sonic.page.getByRole('button', { name: 'Import links' })
        await expect(window).toBeVisible()
        for (const [width, height] of [
          [760, 640],
          [720, 620],
          [1024, 768]
        ] as const) {
          await sonic.evaluateMain(
            ({ BrowserWindow }, size) => {
              const win = BrowserWindow.getAllWindows()[0]
              win.show()
              win.setSize(size[0], size[1])
              win.focus()
            },
            [width, height]
          )
          await expect(window).toBeVisible()
          await sonic.page.screenshot({
            path: join(
              PROJECT_ROOT,
              'diagnostics',
              `improvement-I03-gpu-scale-${String(scaleFactor).replace('.', '-')}-${width}x${height}.png`
            ),
            animations: 'disabled'
          })
        }
        await sonic.evaluateMain(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]
          win.minimize()
        }, null)
        await sonic.evaluateMain(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]
          win.restore()
          win.show()
          win.focus()
        }, null)
        await expect(window).toBeVisible()
        await sonic.page.screenshot({
          path: join(
            PROJECT_ROOT,
            'diagnostics',
            `improvement-I03-gpu-scale-${String(scaleFactor).replace('.', '-')}-restored.png`
          ),
          animations: 'disabled'
        })
        console.log(
          'I03_GPU_SCALE_DIAGNOSTIC',
          JSON.stringify({ requestedScaleFactor: scaleFactor, ...gpu })
        )
      })
    })
  }

  test('minimum window keeps download controls and a network row in view', async ({
    sonic,
    serve
  }) => {
    const minimum = await sonic.evaluateMain(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const [width, height] = window.getMinimumSize()
      window.setSize(width, height)
      return { minimum: [width, height], size: window.getSize() }
    }, null)
    expect(minimum.minimum).toEqual([720, 620])
    expect(minimum.size).toEqual(minimum.minimum)
    const origin = await serve({ size: SIZE })
    const reached = origin.hold(0)
    await sonic.start(origin.url(), origin.sha256)
    await reached
    const page = sonic.page
    await page.getByRole('button', { name: 'Open test.bin', exact: true }).click()
    // An empty bar is still a progress indicator: its track and accessible value must exist
    // before the server sends the first byte.
    const progress = page.getByRole('table', { name: 'Networks' }).getByRole('progressbar').first()
    await expect(progress).toHaveAttribute('aria-valuenow', '0')
    await expect(progress).toBeVisible()
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeInViewport({
      ratio: 1
    })
    await expect(page.getByRole('columnheader', { name: 'Network', exact: true })).toBeInViewport({
      ratio: 1
    })
    await expect(
      page.getByRole('table', { name: 'Networks' }).getByRole('checkbox').first()
    ).toBeInViewport({ ratio: 1 })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    ).toBe(true)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeInViewport({
      ratio: 1
    })
    origin.release()
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await sonic.waitForHttpStatus('completed')
    await expect(page.getByRole('button', { name: /Show in (Finder|folder)/ })).toBeInViewport({
      ratio: 1
    })
  })

  test('paste a link, start, pause, resume, finish, reveal the file', async ({
    sonic,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: SIZE })
    await stubNativeUi(sonic, dirs.dest)
    const page = sonic.page

    const link = await sonic.newDownload()
    await page.getByRole('button', { name: 'Change' }).click()
    await link.fill(origin.url())
    const start = page.getByRole('button', { name: 'Download' })
    await expect(start).toBeEnabled()
    await page.getByRole('group', { name: 'Streams' }).getByRole('button', { name: '8' }).click()

    const reached = origin.hold(6 * BLOCK)
    await sonic.expectNextDownload(origin.sha256)
    await start.click()
    await reached
    // The streams picked in the dialog reach the download.
    const { id } = (await sonic.current())!
    const manifestPath = join(dirs.userData, 'downloads', id, 'manifest.json')
    await expect
      .poll(async () => JSON.parse(await readFile(manifestPath, 'utf-8')).requestPayload)
      .toMatchObject({ streamsPerNetwork: 8 })
    // Started: its own screen opens.
    await page.getByRole('button', { name: 'Pause' }).click()
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Progress', exact: true })).toBeVisible()
    // An HTTP download's connections are streams, and its blocks chunks.
    await expect(page.getByRole('button', { name: /^\d+ streams?/ }).first()).toBeVisible()
    await expect(page.getByText(/^\d+ chunks · /)).toBeVisible()
    origin.release()
    await page.getByRole('button', { name: 'Resume' }).click()

    const reveal = page.getByRole('button', { name: /Show in (Finder|folder)/ })
    await expect(reveal).toBeVisible()
    await expect(page.getByText('Streams', { exact: true })).toBeVisible()
    await expect(page.getByText(/^written in \d+ chunks/)).toBeVisible()
    await reveal.click()
    const { destinationPath } = (await sonic.current())!
    await expect
      .poll(() =>
        sonic.evaluateMain(() => (globalThis as Record<string, unknown>).__revealed, null)
      )
      .toEqual([destinationPath])
  })

  test('delete through the confirmation dialog, then download it again', async ({
    sonic,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: SIZE })
    await stubNativeUi(sonic, dirs.dest)
    const page = sonic.page
    let link = await sonic.newDownload()
    await page.getByRole('button', { name: 'Change' }).click()
    await link.fill(origin.url())

    const reached = origin.hold(6 * BLOCK)
    await page.getByRole('button', { name: 'Download' }).click()
    await reached
    await page.getByRole('button', { name: 'Cancel download' }).click()
    await page.getByRole('button', { name: 'Cancel download', exact: true }).click()
    origin.release()
    // Gone, with what it had downloaded.
    await expect(page.getByText('No downloads yet')).toBeVisible()

    link = await sonic.newDownload()
    await link.fill(origin.url())
    await sonic.expectNextDownload(origin.sha256)
    await page.getByRole('button', { name: 'Download' }).click({ timeout: 5000 })
    await sonic.waitForStatus('completed')
  })

  test('a link the server rejects shows the error and keeps Download disabled', async ({
    sonic,
    serve
  }) => {
    const origin = await serve({ size: SIZE })
    origin.setRule(() => ({ status: 404 }))
    const page = sonic.page
    await (await sonic.newDownload()).fill(origin.url())
    await expect(page.getByText(/couldn.t be found/i)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download' })).toBeDisabled()
  })

  test('a completed download is shown again after a restart', async ({ sonic, serve }) => {
    const origin = await serve({ size: SIZE })
    await sonic.start(origin.url(), origin.sha256)
    const { fileName } = await sonic.waitForStatus('completed')
    await sonic.relaunch()
    // Listed under Finished; opened, it shows as it did when it finished.
    await sonic.page.getByRole('button', { name: `Open ${fileName}` }).click()
    await expect(sonic.page.getByRole('button', { name: /Show in (Finder|folder)/ })).toBeVisible()
  })
})

// Settings must survive a reload or restart; assert only the visible user-facing behavior.
test.describe('settings @smoke', () => {
  test('every choice survives a reload and a restart, even made right before', async ({
    sonic,
    dirs
  }) => {
    const page = (): Page => sonic.page
    const themeToggle = page().getByRole('button', { name: /^Switch to (dark|light) theme$/ })
    // After switching, the toggle offers to switch back.
    const labelAfterSwitch = (await themeToggle.getAttribute('aria-label'))!.includes('dark')
      ? 'Switch to light theme'
      : 'Switch to dark theme'
    await themeToggle.click()

    await stubNativeUi(sonic, dirs.dest)
    await sonic.newDownload()
    await page().getByRole('button', { name: 'Change' }).click()
    const destinationRow = (): Locator => page().getByText('Save to', { exact: true }).locator('..')
    const chosenDestination = await destinationRow().innerText()
    await page().keyboard.press('Escape')
    // A function: the window, and so the page, is a new one after a relaunch.
    const networksMenu = (): Locator =>
      page()
        .getByRole('button', { name: /network/ })
        .first()
        .first()
    await networksMenu().click()
    await page().getByRole('button', { name: 'Edit network' }).first().click()
    await page().getByRole('textbox', { name: 'Name' }).fill('Office fibre')
    await page().getByRole('button', { name: 'Violet' }).click()
    await page().getByRole('button', { name: 'Done' }).click()
    await page().keyboard.press('Escape')

    const expectAllKept = async (): Promise<void> => {
      await expect(page().getByRole('button', { name: labelAfterSwitch })).toBeVisible()
      await sonic.newDownload()
      await expect(destinationRow()).toHaveText(chosenDestination, { useInnerText: true })
      // Presentation may abbreviate home; persistence must retain the usable absolute path.
      const saved = JSON.parse(await readFile(join(dirs.userData, 'app-settings.json'), 'utf8'))
      expect(saved.destinationDir).toBe(dirs.dest)
      await page().keyboard.press('Escape')
      await networksMenu().click()
      await expect(page().getByText('Office fibre')).toBeVisible()
      await page().getByRole('button', { name: 'Edit network' }).first().click()
      await expect(page().getByRole('button', { name: 'Violet' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await page().keyboard.press('Escape')
      await page().keyboard.press('Escape')
    }

    // No waiting for saves: a user doesn't either.
    await page().reload()
    await expectAllKept()
    await sonic.relaunch()
    await expectAllKept()
  })

  test('a broken settings file falls back to what a fresh install shows', async ({
    sonic,
    dirs
  }) => {
    const settingsPath = join(dirs.userData, 'app-settings.json')
    // Compare the complete "Save to" row as presented to the user, so default-folder paths remain platform-independent.
    const choices = async (): Promise<string> => {
      await sonic.newDownload()
      const row = await sonic.page.getByText('Save to', { exact: true }).locator('..').innerText()
      await sonic.page.keyboard.press('Escape')
      return row
    }
    const fresh = await choices()

    await sonic.quit()
    await writeFile(settingsPath, '{"destinationDir": "/')
    await sonic.launch()
    expect(await choices()).toEqual(fresh)

    await sonic.quit()
    await writeFile(settingsPath, JSON.stringify({ destinationDir: join(dirs.dest, 'unplugged') }))
    await sonic.launch()
    expect(await choices()).toEqual(fresh)
  })
})

test.describe('no networks', () => {
  test.use({ appEnv: { SONIC_E2E_INTERFACES: '' } })

  test('a network appearing makes the list ready for downloads @smoke', async ({ sonic }) => {
    await expect(sonic.page.getByText('No networks connected')).toBeVisible()
    // A manual scan is safe while the list stays empty. Once an interface appears, the
    // background monitor can remove this button before Playwright finishes clicking it.
    await sonic.page.getByRole('button', { name: 'Scan again' }).click()
    await expect(sonic.page.getByText('No networks connected')).toBeVisible()
    await sonic.evaluateMain(
      (_electron, value) => {
        process.env['SONIC_E2E_INTERFACES'] = value
      },
      interfacesEnv({ a: NETWORKS['a'] })
    )
    await expect(sonic.page.getByText('No downloads yet')).toBeVisible()
  })
})

test('F-20 language preference persists and applies Urdu right-to-left metadata @smoke', async ({
  sonic
}) => {
  const page = sonic.page
  await page.getByRole('button', { name: 'Open settings' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  // Assert the locale contract through language metadata and persisted state, not copied
  // Urdu strings. This keeps the test meaningful if translations are edited by native speakers.
  const language = page.locator('#sonic-language')
  await language.selectOption('ur')
  await expect(page.locator('html')).toHaveAttribute('lang', 'ur')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('sonic.locale.v1'))).toBe('ur')
  await page.keyboard.press('Escape')

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ur')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('sonic.locale.v1'))).toBe('ur')
})

test('F-20 download, batch import, network and settings dialogs support keyboard focus @smoke', async ({
  sonic
}) => {
  const page = sonic.page
  const focusedVisible = async (): Promise<void> => {
    const active = page.locator(':focus')
    await expect(active).toBeVisible()
    await expect(active).toHaveJSProperty('disabled', false)
  }

  await page.getByRole('button', { name: /network/i }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Active networks')).toBeVisible()
  const editNetwork = page.getByRole('button', { name: 'Edit network' }).first()
  await editNetwork.focus()
  await page.keyboard.press('Enter')
  const networkName = page.getByRole('textbox', { name: 'Name' })
  await expect(networkName).toBeVisible()
  await networkName.focus()
  const networkOutline = await networkName.evaluate(
    (element) => getComputedStyle(element).outlineStyle
  )
  expect(networkOutline).not.toBe('none')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'New download', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('#new-download-link')).toBeVisible()
  await expect(page.locator('#new-download-link')).toBeFocused()
  const linkOutline = await page
    .locator('#new-download-link')
    .evaluate((element) => getComputedStyle(element).outlineStyle)
  expect(linkOutline).not.toBe('none')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Open .torrent' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.getByRole('button', { name: 'Import links' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('textbox').first()).toBeVisible()
  await focusedVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.getByRole('button', { name: 'Open settings' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('#sonic-language')).toBeVisible()
  await focusedVisible()
  const scheduleSwitch = page.getByRole('switch', { name: 'Enable download schedule' })
  await scheduleSwitch.focus()
  await expect(scheduleSwitch).toBeFocused()
  const scheduleBefore = await scheduleSwitch.getAttribute('aria-checked')
  await page.keyboard.press('Space')
  await expect(scheduleSwitch).toHaveAttribute(
    'aria-checked',
    scheduleBefore === 'true' ? 'false' : 'true'
  )
  await page.keyboard.press('Escape')
})

test('F-20 layout remains operable at 200 percent browser zoom and focus rings are explicit @smoke', async ({
  sonic
}) => {
  const page = sonic.page
  await sonic.evaluateMain(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2)
  }, null)
  await page.getByRole('button', { name: 'Open settings' }).focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(page.locator('#sonic-language')).toBeVisible()
  const focusStyle = await page.locator('#sonic-language').evaluate((element) => {
    element.focus()
    return getComputedStyle(element).outlineStyle
  })
  expect(focusStyle).not.toBe('none')
  const textContrast = await page.locator('#sonic-language').evaluate((element) => {
    const channel = (value: number): number => {
      const normalized = value / 255
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
    }
    const luminance = (css: string): number => {
      const values =
        css
          .match(/[0-9.]+/g)
          ?.slice(0, 3)
          .map(Number) ?? []
      if (values.length !== 3) return 0
      const [red, green, blue] = values.map(channel)
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue
    }
    const styles = getComputedStyle(element)
    const ratio = (first: string, second: string): number => {
      const a = luminance(first)
      const b = luminance(second)
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    }
    return {
      text: ratio(styles.color, styles.backgroundColor),
      focus: ratio(styles.outlineColor, styles.backgroundColor)
    }
  })
  expect(textContrast.text).toBeGreaterThanOrEqual(4.5)
  expect(textContrast.focus).toBeGreaterThanOrEqual(3)
  const geometry = await dialog.evaluate((element) => ({
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
    viewport: document.documentElement.clientWidth
  }))
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1)
  await page.keyboard.press('Escape')
  await sonic.evaluateMain(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1)
  }, null)
})
