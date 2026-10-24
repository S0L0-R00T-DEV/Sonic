import type WebTorrent from 'webtorrent'
import type { Torrent, Wire } from 'webtorrent'
import type {
  TorrentDownloadNetwork,
  TorrentDownloadState,
  TorrentPeerState
} from '../src/shared/types'
import {
  Meters,
  type TorrentTransferTarget,
  type TransferHost
} from '../src/main/download/transfer'
import { TorrentTransfer } from '../src/main/download/torrent/torrentTransfer'
import { expect, LAN_ADDRESS, test, treeSha } from './fixtures'
import { seededBytes, sha256 } from './origin'
import { named, Swarm, torrentFileOnDisk } from './torrentSwarm'

// Downloading torrents: every byte right, every peer on a network, and the networks' controls,
// pause and relaunch working as they do for HTTP. The swarm is local (see torrentSwarm.ts); the
// checks fixture verifies each finished download's bytes and that nothing else was left behind.

const KB = 1024
const MB = 1024 * KB
const PIECE = 64 * KB

let swarm: Swarm
test.beforeEach(async () => {
  swarm = await new Swarm().start()
})
test.afterEach(async () => {
  await swarm.stop()
})

test.describe('torrent downloads', () => {
  test('per-task upload cap updates and clears the WebTorrent throttle', async () => {
    const state = {
      maxUploadSpeedBytesPerSecond: 64 * KB,
      uploadRatioReached: undefined
    } as unknown as TorrentDownloadState
    const runtime = { state, uploadMeters: new Meters() } as unknown as TorrentTransferTarget
    const host = { scheduleUpdate: () => {} } as unknown as TransferHost
    const transfer = new TorrentTransfer(runtime, host, new Uint8Array(), 'test.bin')
    const appliedRates: number[] = []
    ;(transfer as unknown as { client: WebTorrent | null }).client = {
      throttleUpload: (rate: number) => appliedRates.push(rate)
    } as unknown as WebTorrent

    transfer.setUploadSpeedLimit(64 * KB)
    expect(appliedRates.at(-1)).toBe(64 * KB)
    state.maxUploadSpeedBytesPerSecond = 96 * KB
    transfer.setUploadSpeedLimit(96 * KB)
    expect(appliedRates.at(-1)).toBe(96 * KB)
    delete state.maxUploadSpeedBytesPerSecond
    transfer.setUploadSpeedLimit(null)
    expect(appliedRates.at(-1)).toBe(-1)
    expect(appliedRates).toEqual([64 * KB, 96 * KB, -1])
  })

  test('manual-stop seeding clears a previously reached ratio threshold', async () => {
    const state = {
      uploadRatioLimit: 1,
      uploadRatioReached: true,
      bytesDownloaded: 1000,
      bytesUploaded: 1000
    } as unknown as TorrentDownloadState
    const runtime = { state, uploadMeters: new Meters() } as unknown as TorrentTransferTarget
    const host = { scheduleUpdate: () => {} } as unknown as TransferHost
    const transfer = new TorrentTransfer(runtime, host, new Uint8Array(), 'test.bin')
    const throttled: number[] = []
    ;(transfer as unknown as { client: WebTorrent | null }).client = {
      throttleUpload: (rate: number) => throttled.push(rate)
    } as unknown as WebTorrent

    transfer.setUploadRatioLimit(0)
    expect(state.uploadRatioLimit).toBe(0)
    expect(state.uploadRatioReached).toBeUndefined()
    expect(throttled.at(-1)).toBe(-1)
  })

  test('a completed seeding torrent throttles uploads to zero when its ratio cap is reached', async () => {
    const network: TorrentDownloadNetwork = {
      id: 'test-network',
      label: 'Test network',
      kind: 'other',
      enabled: true,
      status: 'on',
      bytesDownloaded: 1000,
      speedBytesPerSec: 0,
      retries: 0,
      transfer: 'torrent',
      bytesUploaded: 0,
      uploadSpeedBytesPerSec: 0
    }
    const peer: TorrentPeerState = {
      id: 1,
      interfaceId: network.id,
      status: 'connected',
      client: null,
      bytesDownloaded: 0,
      speedBytesPerSec: 0,
      bytesUploaded: 0,
      uploadSpeedBytesPerSec: 0
    }
    const state: TorrentDownloadState = {
      id: 'ratio-policy-test',
      kind: 'torrent',
      url: 'magnet:?xt=urn:btih:test',
      fileName: 'test.bin',
      destinationPath: 'test.bin',
      totalBytes: 1000,
      bytesDownloaded: 1000,
      speedBytesPerSec: 0,
      status: 'completed',
      startedAt: Date.now(),
      networks: [network],
      peers: [peer],
      peakPeers: 1,
      pieces: [],
      totalPieces: 1,
      pieceLength: 1000,
      files: { chosen: 1, total: 1 },
      folder: false,
      skippedBytes: 0,
      bytesUploaded: 0,
      uploadSpeedBytesPerSec: 0,
      maxUploadSpeedBytesPerSecond: 32 * KB,
      uploadRatioLimit: 0.1,
      seeding: true
    }
    const runtime = { state, uploadMeters: new Meters() } as unknown as TorrentTransferTarget
    const host = { scheduleUpdate: () => {} } as unknown as TransferHost
    const transfer = new TorrentTransfer(runtime, host, new Uint8Array(), 'test.bin')
    const throttled: number[] = []
    ;(transfer as unknown as { client: WebTorrent | null }).client = {
      throttleUpload: (rate: number) => throttled.push(rate)
    } as unknown as WebTorrent
    ;(
      transfer as unknown as {
        onUpload: (
          network: TorrentDownloadNetwork,
          peer: { state: TorrentPeerState },
          bytes: number
        ) => void
      }
    ).onUpload(network, { state: peer }, 150)

    expect(state.uploadRatioReached).toBe(true)
    expect(state.bytesUploaded).toBe(150)
    expect(network.bytesUploaded).toBe(150)
    expect(throttled.at(-1)).toBe(0)
  })

  test('a single-file torrent', async ({ sonic }) => {
    const data = seededBytes(2 * MB, 11)
    const torrent = await swarm.seed([named(data, 'movie.mkv')], { pieceLength: PIECE })

    await sonic.start(await torrentFileOnDisk(torrent), sha256(data))
    const done = await sonic.waitForTorrentStatus('completed', 30_000)
    expect(done.kind).toBe('torrent')
    expect(done.fileName).toBe('movie.mkv')
    expect(done.totalPieces).toBe((2 * MB) / PIECE)
  })

  test('a torrent of several files, published as its folder', async ({ sonic }) => {
    const files = [
      named(seededBytes(300 * KB, 21), 'a.bin'),
      named(seededBytes(700 * KB + 3, 22), 'b.bin'),
      named(seededBytes(5, 23), 'tiny.txt')
    ]
    const torrent = await swarm.seed(files, { folder: 'Album', pieceLength: PIECE })

    const expected = treeSha(
      files.map((data) => ({ path: (data as { name?: string }).name!, data }))
    )
    await sonic.start(await torrentFileOnDisk(torrent), expected)
    const done = await sonic.waitForTorrentStatus('completed', 30_000)
    expect(done.fileName).toBe('Album')
  })

  test('per-task upload cap is applied live and survives relaunch', async ({ sonic }) => {
    const data = seededBytes(6 * MB, 17)
    const torrent = await swarm.seed([named(data, 'capped.bin')], {
      pieceLength: PIECE,
      uploadLimit: 300 * KB
    })
    const id = await sonic.start(await torrentFileOnDisk(torrent), sha256(data))
    await sonic.waitUntil((state) => state.bytesDownloaded >= 512 * KB, 30_000)
    await sonic.api.refreshTorrentTrackers(id)

    await sonic.api.setUploadSpeedLimit(id, 64 * KB)
    let current = await sonic.currentTorrent()
    expect(current?.maxUploadSpeedBytesPerSecond).toBe(64 * KB)

    // Changing it while running exercises WebTorrent's live throttle, not only saved state.
    await sonic.api.setUploadSpeedLimit(id, 96 * KB)
    current = await sonic.currentTorrent()
    expect(current?.maxUploadSpeedBytesPerSecond).toBe(96 * KB)
    await sonic.api.setUploadRatioLimit(id, 2)
    current = await sonic.currentTorrent()
    expect(current?.uploadRatioLimit).toBe(2)

    await sonic.relaunch()
    const paused = await sonic.waitForTorrentStatus('paused')
    expect(paused.maxUploadSpeedBytesPerSecond).toBe(96 * KB)
    expect(paused.uploadRatioLimit).toBe(2)
    // A refresh attempt while paused must fail clearly; the UI surfaces this rejection inline.
    await expect(sonic.api.refreshTorrentTrackers(id)).rejects.toThrow(
      'Resume the torrent before refreshing its trackers.'
    )
    await sonic.api.resumeDownload(id)
    await sonic.waitUntil((state) => state.status === 'downloading', 15_000)
    await sonic.api.refreshTorrentTrackers(id)
    const done = await sonic.waitForTorrentStatus('completed', 60_000)
    expect(done.maxUploadSpeedBytesPerSecond).toBe(96 * KB)
    expect(done.uploadRatioLimit).toBe(2)
  })

  test('a finite ratio enables post-completion seeding and can be stopped manually', async ({
    sonic
  }) => {
    const data = seededBytes(2 * MB, 18)
    const torrent = await swarm.seed([named(data, 'bounded-seed.bin')], { pieceLength: PIECE })
    const id = await sonic.start(await torrentFileOnDisk(torrent), sha256(data))
    await sonic.api.setUploadRatioLimit(id, 2)

    const completed = await sonic.waitForTorrentStatus('completed', 30_000)
    expect(completed.kind).toBe('torrent')
    if (completed.kind !== 'torrent') throw new Error('Expected a completed torrent')
    expect(completed.uploadRatioLimit).toBe(2)
    expect(completed.seeding).toBe(true)
    expect(completed.uploadRatioReached).not.toBe(true)

    await sonic.api.stopSeeding(id)
    await expect
      .poll(async () => (await sonic.api.listHistory()).some((entry) => entry.id === id))
      .toBe(true)
    const history = (await sonic.api.listHistory()).find((entry) => entry.id === id)
    expect(history?.kind).toBe('torrent')
    if (history?.kind !== 'torrent') throw new Error('Expected torrent history')
    expect(history.seeding).toBe(false)
    expect(history.uploadRatioLimit).toBe(2)
  })

  test('explicit manual-stop policy keeps a completed torrent seeding until stopped', async ({
    sonic
  }) => {
    const data = seededBytes(2 * MB, 181)
    const torrent = await swarm.seed([named(data, 'manual-stop-seed.bin')], { pieceLength: PIECE })
    const id = await sonic.start(await torrentFileOnDisk(torrent), sha256(data))
    await sonic.api.setUploadRatioLimit(id, 0)

    const completed = await sonic.waitForTorrentStatus('completed', 30_000)
    expect(completed.kind).toBe('torrent')
    if (completed.kind !== 'torrent') throw new Error('Expected a completed torrent')
    expect(completed.uploadRatioLimit).toBe(0)
    expect(completed.seeding).toBe(true)
    expect(completed.uploadRatioReached).not.toBe(true)

    await sonic.api.stopSeeding(id)
    await expect
      .poll(async () => {
        const entry = (await sonic.api.listHistory()).find((item) => item.id === id)
        return entry?.kind === 'torrent' ? entry.seeding : undefined
      })
      .toBe(false)
    const history = (await sonic.api.listHistory()).find((entry) => entry.id === id)
    expect(history?.kind).toBe('torrent')
    if (history?.kind !== 'torrent') throw new Error('Expected torrent history')
    expect(history.uploadRatioLimit).toBe(0)
    expect(history.uploadRatioReached).not.toBe(true)
  })

  test('pause, quit, relaunch and resume: the pieces already done aren’t fetched again', async ({
    sonic
  }) => {
    const data = seededBytes(6 * MB, 31)
    const file = named(data, 'big.iso')
    // Slow enough to stop partway: three seeders at 300 KB/s each.
    let torrent = await swarm.seed([file], { pieceLength: PIECE, uploadLimit: 300 * KB })
    for (let seeder = 1; seeder < 3; seeder++) {
      torrent = await swarm.seed([file], { pieceLength: PIECE, uploadLimit: 300 * KB })
    }

    const id = await sonic.start(await torrentFileOnDisk(torrent), sha256(data))
    await sonic.waitUntil((state) => state.bytesDownloaded >= 2 * MB, 30_000)
    await sonic.relaunch()
    const paused = await sonic.waitForTorrentStatus('paused')
    expect(paused.bytesDownloaded).toBeGreaterThanOrEqual(2 * MB)

    const sentBefore = swarm.uploaded()
    await sonic.api.resumeDownload(id)
    await sonic.waitForTorrentStatus('completed', 60_000)
    // What was missing, plus at most a few pieces each peer had half-sent when it stopped.
    expect(swarm.uploaded() - sentBefore).toBeLessThanOrEqual(
      data.length - paused.bytesDownloaded + 6 * PIECE
    )
  })
})

test.describe('advanced torrent controls', () => {
  test('custom trackers persist across relaunch and can be removed', async ({ sonic }) => {
    const data = seededBytes(8 * MB, 211)
    const torrent = await swarm.seed([named(data, 'tracker-config.bin')], {
      pieceLength: PIECE,
      uploadLimit: 300 * KB
    })
    await swarm.seed([named(data, 'tracker-config.bin')], {
      pieceLength: PIECE,
      uploadLimit: 300 * KB
    })
    const id = await sonic.start(await torrentFileOnDisk(torrent), sha256(data))
    await sonic.waitUntil((state) => state.bytesDownloaded >= 512 * KB, 30_000)

    const custom = ['http://127.0.0.1:1/announce', 'udp://127.0.0.1:2/announce']
    await sonic.api.setTorrentTrackers(id, custom)
    expect((await sonic.currentTorrent())?.customTrackers).toEqual(custom)

    await sonic.relaunch()
    const paused = await sonic.waitForTorrentStatus('paused')
    expect(paused.customTrackers).toEqual(custom)
    expect((await sonic.api.torrentFiles(id))[0].priority).toBe(1)

    await sonic.api.setTorrentTrackers(id, [])
    expect((await sonic.currentTorrent())?.customTrackers).toBeUndefined()
    await sonic.api.resumeDownload(id)
    await sonic.waitForTorrentStatus('completed', 30_000)
  })

  test('numeric per-file priorities apply to the engine and survive relaunch', async ({
    sonic
  }) => {
    const files = [
      named(seededBytes(700 * KB, 212), 'priority-low.bin'),
      named(seededBytes(700 * KB, 213), 'priority-high.bin')
    ]
    const torrent = await swarm.seed(files, {
      folder: 'Priorities',
      pieceLength: PIECE,
      uploadLimit: 300 * KB
    })
    const id = await sonic.start(
      await torrentFileOnDisk(torrent),
      treeSha(files.map((data) => ({ path: (data as { name?: string }).name!, data })))
    )
    await sonic.waitUntil((state) => state.bytesDownloaded > 0, 30_000)
    await sonic.api.setTorrentFilePriority(id, 1, 2)
    expect((await sonic.api.torrentFiles(id))[1].priority).toBe(2)

    await sonic.relaunch()
    const paused = await sonic.waitForTorrentStatus('paused')
    expect(paused.filePriorities).toEqual([1, 2])
    expect((await sonic.api.torrentFiles(id))[1].priority).toBe(2)
    await sonic.api.resumeDownload(id)
    await sonic.waitForTorrentStatus('completed', 30_000)
  })
})

test.describe('choosing files', () => {
  /** Files of sizes that don't line up with pieces, so pieces straddle chosen and skipped ones. */
  function album(size: number, seed: number): Buffer[] {
    return ['a.bin', 'b.bin', 'c.bin', 'd.bin'].map((name, index) =>
      named(seededBytes(size + 7 * index + 5, seed + index), name)
    )
  }
  const shaOf = (files: Buffer[]): string =>
    treeSha(files.map((data) => ({ path: (data as { name?: string }).name!, data })))

  test('only the chosen files are downloaded and published', async ({ sonic }) => {
    const files = album(300 * KB, 61)
    const torrent = await swarm.seed(files, { folder: 'Album', pieceLength: PIECE })

    // a and c chosen: b and d never appear, though the pieces at their edges are fetched.
    await sonic.start(await torrentFileOnDisk(torrent), shaOf([files[0], files[2]]), {
      selectedFiles: [0, 2]
    })
    const done = await sonic.waitForTorrentStatus('completed', 30_000)
    expect(done.skippedBytes).toBeGreaterThan(0)
    expect(done.bytesDownloaded).toBe(done.totalBytes - done.skippedBytes!)
    expect(done.pieces.filter((piece) => piece.status === 'skipped').length).toBeGreaterThan(0)
  })

  test('the choice is kept through a quit, a relaunch and a resume', async ({ sonic }) => {
    const files = album(1500 * KB, 71)
    let torrent = await swarm.seed(files, {
      folder: 'Set',
      pieceLength: PIECE,
      uploadLimit: 300 * KB
    })
    for (let seeder = 1; seeder < 3; seeder++) {
      torrent = await swarm.seed(files, {
        folder: 'Set',
        pieceLength: PIECE,
        uploadLimit: 300 * KB
      })
    }

    const id = await sonic.start(await torrentFileOnDisk(torrent), shaOf([files[1], files[3]]), {
      selectedFiles: [1, 3]
    })
    await sonic.waitUntil((state) => state.bytesDownloaded >= 1 * MB, 30_000)
    const before = await sonic.currentTorrent()
    await sonic.relaunch()
    const paused = await sonic.waitForTorrentStatus('paused')
    expect(paused.skippedBytes).toBe(before!.skippedBytes)
    await sonic.api.resumeDownload(id)
    await sonic.waitForTorrentStatus('completed', 60_000)
  })

  test('the choice changes as it runs: a file dropped never appears, one added comes in', async ({
    sonic
  }) => {
    const files = album(1500 * KB, 81)
    let torrent = await swarm.seed(files, {
      folder: 'Mix',
      pieceLength: PIECE,
      uploadLimit: 300 * KB
    })
    for (let seeder = 1; seeder < 3; seeder++) {
      torrent = await swarm.seed(files, {
        folder: 'Mix',
        pieceLength: PIECE,
        uploadLimit: 300 * KB
      })
    }

    // a and b chosen, then b swapped for c before either is near done.
    const id = await sonic.start(await torrentFileOnDisk(torrent), shaOf([files[0], files[2]]), {
      selectedFiles: [0, 1]
    })
    await sonic.waitUntil((state) => state.bytesDownloaded > 0, 30_000)
    await sonic.api.chooseTorrentFiles(id, [0, 2])
    const changed = await sonic.currentTorrent()
    expect(changed!.status).toBe('downloading')
    expect(changed!.files).toEqual({ chosen: 2, total: 4, selected: [0, 2] })
    await sonic.waitForTorrentStatus('completed', 60_000)
  })
})

test.describe('torrents over two networks', () => {
  test.skip(
    !LAN_ADDRESS || LAN_ADDRESS.startsWith('127.'),
    'requires a non-loopback LAN address; WebTorrent peer advertisement is unsupported on isolated loopback aliases'
  )

  /** Three seeders of `data`, at `uploadLimit` each. */
  async function seedThree(data: Buffer, name: string, uploadLimit?: number): Promise<Torrent> {
    const file = named(data, name)
    let torrent = await swarm.seed([file], { pieceLength: PIECE, uploadLimit })
    for (let seeder = 1; seeder < 3; seeder++) {
      torrent = await swarm.seed([file], { pieceLength: PIECE, uploadLimit })
    }
    return torrent
  }

  test('both networks carry peers and deliver pieces', async ({ sonic }) => {
    const data = seededBytes(4 * MB, 41)
    const torrent = await seedThree(data, 'both.bin', 1 * MB)

    await sonic.start(await torrentFileOnDisk(torrent), sha256(data), { networks: ['a', 'b'] })
    const done = await sonic.waitForTorrentStatus('completed', 30_000)
    for (const id of ['a', 'b']) {
      const network = done.networks.find((entry) => entry.id === id)!
      expect(network.bytesDownloaded, `network ${id} delivered pieces`).toBeGreaterThan(0)
    }
    const seen = new Set(
      sonic.sessions.flat().flatMap((state) => (state.kind === 'torrent' ? state.peers : []))
    )
    expect(new Set([...seen].map((peer) => peer.interfaceId))).toEqual(new Set(['a', 'b']))
  })

  test('switching a network off moves its peers to the other', async ({ sonic }) => {
    const data = seededBytes(6 * MB, 42)
    const torrent = await seedThree(data, 'switch.bin', 300 * KB)

    const id = await sonic.start(await torrentFileOnDisk(torrent), sha256(data), {
      networks: ['a', 'b']
    })
    await sonic.waitUntil(
      (state) => state.networks.every((network) => network.bytesDownloaded > 0),
      30_000
    )
    await sonic.api.setDownloadNetwork(id, 'b', false)
    await sonic.waitUntil(
      (state) => state.kind === 'torrent' && !state.peers.some((peer) => peer.interfaceId === 'b')
    )
    const done = await sonic.waitForTorrentStatus('completed', 60_000)
    expect(done.networks.find((network) => network.id === 'b')?.enabled).toBe(false)
  })
})

test.describe('uploading', () => {
  test.skip(
    !LAN_ADDRESS || LAN_ADDRESS.startsWith('127.'),
    'requires a non-loopback LAN address; WebTorrent peer advertisement is unsupported on isolated loopback aliases'
  )
  // A USB-tethered network, the one kind once left out: every network uploads, whatever its kind.
  test.use({ appEnv: { SONIC_E2E_INTERFACES: `b=${LAN_ADDRESS}==usb` } })

  test('a completed torrent seeds until its ratio cap is reached, then shuts uploads off', async ({
    sonic
  }) => {
    const data = seededBytes(4 * MB, 52)
    const torrent = await swarm.seed([named(data, 'ratio-seed.bin')], {
      pieceLength: PIECE,
      uploadLimit: 400 * KB
    })
    const id = await sonic.start(await torrentFileOnDisk(torrent), sha256(data), {
      networks: ['b']
    })
    // No leecher is present during the download, so the cap cannot be reached prematurely.
    await sonic.api.setUploadRatioLimit(id, 0.1)
    const completed = await sonic.waitForTorrentStatus('completed', 30_000)
    expect(completed.kind).toBe('torrent')
    if (completed.kind !== 'torrent') throw new Error('Expected a completed torrent')
    expect(completed.seeding).toBe(true)

    let fromSonic = 0
    const other = await swarm.leech(torrent)
    other.on('wire', (wire: Wire) => {
      wire.on('download', (bytes: number) => (fromSonic += bytes))
    })
    await sonic.waitUntil(
      (state) => state.kind === 'torrent' && state.uploadRatioReached === true,
      60_000
    )
    expect(fromSonic, 'the leecher received data from Sonic after completion').toBeGreaterThan(0)
    await expect
      .poll(async () => {
        const history = await sonic.api.listHistory()
        const entry = history.find((item) => item.id === id)
        return entry?.kind === 'torrent' ? entry.uploadRatioReached : undefined
      })
      .toBe(true)
    const history = (await sonic.api.listHistory()).find((entry) => entry.id === id)
    expect(history?.kind).toBe('torrent')
    if (history?.kind !== 'torrent') throw new Error('Expected torrent history')
    expect(history.seeding).toBe(false)
    expect(history.uploadSpeedBytesPerSec ?? 0).toBe(0)
  })

  test('peers get pieces back over every network, USB-tethered ones too', async ({ sonic }) => {
    const data = seededBytes(4 * MB, 51)
    const torrent = await swarm.seed([named(data, 'shared.bin')], {
      pieceLength: PIECE,
      uploadLimit: 400 * KB
    })
    const id = await sonic.start(await torrentFileOnDisk(torrent), sha256(data), {
      networks: ['b']
    })
    await sonic.api.setUploadRatioLimit(id, 0.1)
    await sonic.waitForTorrentStatus('completed', 60_000)
    await swarm.stopSeeders()

    // Add the leecher after Sonic is in the swarm and stop the original seeder, so the
    // received-byte counter can only measure Sonic's upload over the USB/LAN interface.
    const other = await swarm.leech(torrent)
    let fromSonic = 0
    let connected = false
    other.on('wire', (wire: Wire, address: string) => {
      if (!address.replace(/^::ffff:/, '').startsWith(`${LAN_ADDRESS}:`)) return
      connected = true
      wire.on('download', (bytes: number) => (fromSonic += bytes))
    })

    await sonic.waitUntil(
      (state) => state.kind === 'torrent' && state.uploadRatioReached === true,
      60_000
    )
    const done = await sonic.waitForTorrentStatus('completed', 60_000)
    expect(done.uploadRatioLimit).toBe(0.1)
    expect(done.uploadRatioReached).toBe(true)
    expect(connected, 'Sonic connected to the other client').toBe(true)
    expect(fromSonic, 'what the other client received from Sonic').toBeGreaterThan(0)
    const sentOverB = done.networks.find((network) => network.id === 'b')?.bytesUploaded ?? 0
    expect(sentOverB).toBeGreaterThanOrEqual(fromSonic)
    expect(done.bytesUploaded).toBe(sentOverB)
    expect(done.uploadSpeedBytesPerSec ?? 0).toBe(0)
  })

  test('per-task upload cap limits bytes a connected peer actually receives', async ({ sonic }) => {
    const data = seededBytes(8 * MB, 52)
    const torrent = await swarm.seed([named(data, 'rate-capped.bin')], {
      pieceLength: PIECE,
      uploadLimit: 400 * KB
    })
    const id = await sonic.start(await torrentFileOnDisk(torrent), sha256(data), {
      networks: ['b']
    })
    await sonic.api.setUploadSpeedLimit(id, 32 * KB)
    await sonic.waitUntil((state) => state.bytesDownloaded >= 512 * KB, 30_000)
    // Stop the source seeder while Sonic is still downloading. The leecher can then measure
    // only Sonic's capped upload, not bytes received from the original seeder on the same IP.
    await swarm.stopSeeders()

    const other = await swarm.leech(torrent)
    let fromSonic = 0
    let resolveConnected!: () => void
    const connected = new Promise<void>((resolve) => (resolveConnected = resolve))
    other.on('wire', (wire: Wire, address: string) => {
      if (!address.replace(/^::ffff:/, '').startsWith(`${LAN_ADDRESS}:`)) return
      wire.on('download', (bytes: number) => (fromSonic += bytes))
      resolveConnected()
    })
    await Promise.race([
      connected,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('The local peer did not connect to Sonic.')), 20_000)
      )
    ])
    const before = fromSonic
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    const received = fromSonic - before
    expect(received, 'the peer should receive data from Sonic under the cap').toBeGreaterThan(0)
    expect(received).toBeLessThanOrEqual(32 * KB * 4 * 2 + PIECE)
    expect((await sonic.currentTorrent())?.maxUploadSpeedBytesPerSecond).toBe(32 * KB)

    // A ratio reached while the task is running stops further uploads; clearing both controls
    // removes their persisted state rather than leaving a zero-rate or reached flag behind.
    await sonic.api.setUploadRatioLimit(id, 0.1)
    await sonic.waitUntil(
      (state) => state.kind === 'torrent' && state.uploadRatioReached === true,
      10_000
    )
    const stoppedAt = fromSonic
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(fromSonic - stoppedAt).toBeLessThanOrEqual(2 * PIECE)
    await sonic.api.setUploadRatioLimit(id, null)
    await sonic.api.setUploadSpeedLimit(id, null)
    const cleared = await sonic.currentTorrent()
    expect(cleared?.uploadRatioLimit).toBeUndefined()
    expect(cleared?.uploadRatioReached).toBeUndefined()
    expect(cleared?.maxUploadSpeedBytesPerSecond).toBeUndefined()
  })
})

test.describe
  .skip('upload cap enforcement on isolated loopback aliases — loopback peer advertisement unsupported', () => {
  // Two loopback addresses let the test distinguish Sonic's peer connection from the seeder
  // without relying on a physical LAN adapter being present on the test machine.
  test.use({ appEnv: { SONIC_E2E_INTERFACES: 'a=127.0.0.1,b=127.0.0.2==usb' } })

  test('a live per-task cap limits bytes received by a connected peer', async ({ sonic }) => {
    const data = seededBytes(8 * MB, 53)
    const torrent = await swarm.seed([named(data, 'loopback-rate-capped.bin')], {
      pieceLength: PIECE,
      uploadLimit: 400 * KB
    })
    let fromSonic = 0
    let resolveConnected!: () => void
    const connected = new Promise<void>((resolve) => (resolveConnected = resolve))
    const id = await sonic.start(await torrentFileOnDisk(torrent), sha256(data), {
      networks: ['b']
    })
    await sonic.waitUntil((state) => state.bytesDownloaded >= 512 * KB, 30_000)
    // Remove the original seeder before creating the leecher, so all bytes it receives must come
    // from Sonic rather than being satisfied by another peer in the local swarm.
    await torrent.destroy()
    const other = await swarm.leech(torrent)
    other.on('wire', (wire: Wire) => {
      wire.on('download', (bytes: number) => (fromSonic += bytes))
      resolveConnected()
    })
    await sonic.api.refreshTorrentTrackers(id)
    let connectionTimeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        connected,
        new Promise<never>((_, reject) => {
          connectionTimeout = setTimeout(
            () => reject(new Error('The local peer did not connect to Sonic.')),
            20_000
          )
        })
      ])
    } finally {
      if (connectionTimeout) clearTimeout(connectionTimeout)
    }

    await sonic.api.setUploadSpeedLimit(id, 32 * KB)
    const before = fromSonic
    await expect.poll(() => fromSonic - before, { timeout: 20_000 }).toBeGreaterThan(0)
    const capStart = fromSonic
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    const received = fromSonic - capStart
    expect(received, 'the peer should receive data from Sonic under the cap').toBeGreaterThan(0)
    // Allow one piece of protocol/buffer burst, while detecting an unthrottled transfer.
    expect(received).toBeLessThanOrEqual(32 * KB * 4 * 2 + PIECE)
    expect((await sonic.currentTorrent())?.maxUploadSpeedBytesPerSecond).toBe(32 * KB)

    // A ratio reached while the task is running stops further uploads; clearing both controls
    // removes their persisted state rather than leaving a zero-rate or reached flag behind.
    await sonic.api.setUploadRatioLimit(id, 0.1)
    await sonic.waitUntil(
      (state) => state.kind === 'torrent' && state.uploadRatioReached === true,
      10_000
    )
    const stoppedAt = fromSonic
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(fromSonic - stoppedAt).toBeLessThanOrEqual(2 * PIECE)
    await sonic.api.setUploadRatioLimit(id, null)
    await sonic.api.setUploadSpeedLimit(id, null)
    const cleared = await sonic.currentTorrent()
    expect(cleared?.uploadRatioLimit).toBeUndefined()
    expect(cleared?.uploadRatioReached).toBeUndefined()
    expect(cleared?.maxUploadSpeedBytesPerSecond).toBeUndefined()
  })
})
