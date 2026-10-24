import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './fixtures'

const HAS_FFMPEG = (() => {
  try {
    execFileSync(process.env['SONIC_FFMPEG_PATH'] || 'ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

async function listenFiles(
  files: Map<string, { body: Buffer; type: string }>
): Promise<{ server: Server; url: (path: string) => string }> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const file = files.get(path)
    if (!file) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.body.length })
    response.end(file.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Test media server did not bind to a TCP port.')
  return { server, url: (path) => `http://127.0.0.1:${address.port}${path}` }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
}

test('downloads and publishes a local on-demand HLS stream through FFmpeg', async ({
  sonic,
  dirs
}) => {
  test.skip(!HAS_FFMPEG, 'FFmpeg is not installed in this test environment.')
  const sourceDir = await mkdtemp(join(tmpdir(), 'sonic-hls-fixture-'))
  let origin: Awaited<ReturnType<typeof listenFiles>> | undefined
  try {
    execFileSync(
      process.env['SONIC_FFMPEG_PATH'] || 'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=160x90:rate=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=1000:sample_rate=44100',
        '-t',
        '1',
        '-map',
        '0:v:0',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-map',
        '1:a:0',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-f',
        'hls',
        '-hls_time',
        '1',
        '-hls_list_size',
        '0',
        '-var_stream_map',
        'v:0,agroup:aud a:0,agroup:aud,default:yes',
        '-master_pl_name',
        'source.m3u8',
        '-hls_segment_filename',
        join(sourceDir, 'segment%v_%02d.ts'),
        join(sourceDir, 'source_%v.m3u8')
      ],
      { stdio: 'ignore' }
    )
    const files = new Map<string, { body: Buffer; type: string }>()
    for (const name of await readdir(sourceDir)) {
      const body = await readFile(join(sourceDir, name))
      files.set(`/${name}`, {
        body,
        type: name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t'
      })
    }
    origin = await listenFiles(files)
    const probe = await sonic.api.probeUrl(origin.url('/source.m3u8'))
    expect(probe.kind).toBe('http')
    if (probe.kind !== 'http' || !probe.media) throw new Error('Expected a detected HLS stream.')
    // Choose a valid window that only opens tomorrow. Media should be queued rather than rejected
    // outside the schedule, then start when the schedule is disabled.
    const closedSchedule = {
      enabled: true,
      startMinute: 0,
      endMinute: 1,
      days: [(new Date().getDay() + 1) % 7]
    }
    await sonic.api.updateSettings({
      downloadSchedule: closedSchedule,
      completionAction: 'none',
      speedLimit: 8_000
    })
    const id = await sonic.api.startDownload({
      kind: 'http',
      url: probe.finalUrl,
      destinationDir: dirs.dest,
      suggestedFileName: 'fixture-media.mp4',
      totalBytes: 0,
      supportsRanges: false,
      interfaceIds: [],
      etag: null,
      lastModified: null,
      mediaStream: {
        protocol: 'hls',
        manifestUrl: probe.media.manifestUrl,
        variantId: probe.media.variants[0].id,
        variantUrl: probe.media.variants[0].url,
        ...(probe.media.variants[0].audioUrl ? { audioUrl: probe.media.variants[0].audioUrl } : {})
      }
    })
    const queued = await sonic.waitUntil(
      (state) => state.id === id && state.status === 'queued',
      10_000
    )
    expect(queued.status).toBe('queued')
    await sonic.api.setDownloadSpeedLimit(id, 6_000)
    // A queued media task survives a normal app restart. Its manifest and queue position must
    // recover without launching FFmpeg outside the closed schedule window.
    await sonic.relaunch()
    const restoredQueued = await sonic.waitUntil(
      (state) => state.id === id && state.status === 'queued',
      10_000
    )
    expect(restoredQueued.status).toBe('queued')
    await sonic.api.updateSettings({
      downloadSchedule: { ...closedSchedule, enabled: false },
      networkPreferences: { 'test-policy-network': { dataLimit: 1 } }
    })
    const policyQueued = await sonic.waitUntil(
      (state) =>
        state.id === id &&
        state.status === 'queued' &&
        state.queueReason?.includes('per-network data limits are disabled') === true,
      10_000
    )
    expect(policyQueued.queueReason).toContain('FFmpeg cannot attribute exact received bytes')
    await sonic.api.updateSettings({ networkPreferences: {} })
    const complete = await sonic.waitUntil(
      (state) => state.id === id && state.status === 'completed',
      30_000
    )
    expect(complete.kind).toBe('http')
    expect((await readFile(complete.destinationPath)).length).toBeGreaterThan(0)
    expect(
      (await sonic.api.listHistory()).some(
        (entry) => entry.id === id && entry.status === 'completed'
      )
    ).toBe(true)
    expect(complete.destinationPath).toMatch(/fixture-media(?: \(\d+\))?\.mp4$/i)
  } finally {
    if (origin) await close(origin.server)
    await rm(sourceDir, { recursive: true, force: true })
  }
})

test('corrupt media manifests are preserved and surfaced as recovery issues', async ({
  sonic,
  dirs
}) => {
  const id = '11111111-1111-4111-8111-111111111111'
  const root = join(dirs.userData, 'media-downloads')
  const path = join(root, id + '.json')
  await mkdir(root, { recursive: true })
  await writeFile(path, '{ invalid json', 'utf8')

  await sonic.relaunch()
  const issues = await sonic.api.listRecoveryIssues()
  expect(issues.some((issue) => issue.id === id && issue.manifestPath === path)).toBe(true)
  expect(await readFile(path, 'utf8')).toBe('{ invalid json')
})

test('downloads the selected static DASH video representation through FFmpeg', async ({
  sonic,
  dirs
}) => {
  test.skip(!HAS_FFMPEG, 'FFmpeg is not installed in this test environment.')
  const sourceDir = await mkdtemp(join(tmpdir(), 'sonic-dash-fixture-'))
  let origin: Awaited<ReturnType<typeof listenFiles>> | undefined
  try {
    execFileSync(
      process.env['SONIC_FFMPEG_PATH'] || 'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=160x90:rate=10',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x180:rate=10',
        '-t',
        '2',
        '-map',
        '0:v:0',
        '-map',
        '1:v:0',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-b:v:0',
        '200k',
        '-b:v:1',
        '500k',
        '-f',
        'dash',
        '-seg_duration',
        '1',
        '-use_template',
        '1',
        '-use_timeline',
        '1',
        '-adaptation_sets',
        'id=0,streams=v',
        'source.mpd'
      ],
      { stdio: 'ignore', cwd: sourceDir }
    )
    const files = new Map<string, { body: Buffer; type: string }>()
    for (const name of await readdir(sourceDir)) {
      files.set(`/${name}`, {
        body: await readFile(join(sourceDir, name)),
        type: name.endsWith('.mpd') ? 'application/dash+xml' : 'application/octet-stream'
      })
    }
    origin = await listenFiles(files)
    const probe = await sonic.api.probeUrl(origin.url('/source.mpd'))
    expect(probe.kind).toBe('http')
    if (probe.kind !== 'http' || !probe.media || probe.media.protocol !== 'dash') {
      throw new Error('Expected a detected static DASH stream.')
    }
    const selected = probe.media.variants.find((variant) => variant.height === 180)
    expect(selected, 'The 180p DASH representation should be selectable').toBeTruthy()
    if (!selected) throw new Error('The selected DASH representation is missing.')
    const id = await sonic.api.startDownload({
      kind: 'http',
      url: probe.finalUrl,
      destinationDir: dirs.dest,
      suggestedFileName: 'fixture-dash.mp4',
      totalBytes: 0,
      supportsRanges: false,
      interfaceIds: [],
      etag: null,
      lastModified: null,
      mediaStream: {
        protocol: 'dash',
        manifestUrl: probe.media.manifestUrl,
        variantId: selected.id,
        variantUrl: selected.url
      }
    })
    const complete = await sonic.waitUntil(
      (state) => state.id === id && state.status === 'completed',
      30_000
    )
    const dimensions = execFileSync(
      process.env['SONIC_FFPROBE_PATH'] || 'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'csv=s=x:p=0',
        complete.destinationPath
      ],
      { encoding: 'utf8' }
    ).trim()
    expect(dimensions).toBe('320x180')
    expect((await readFile(complete.destinationPath)).length).toBeGreaterThan(0)
  } finally {
    if (origin) await close(origin.server)
    await rm(sourceDir, { recursive: true, force: true })
  }
})
