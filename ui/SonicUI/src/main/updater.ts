import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, shell } from 'electron'
import { fingerprintEd25519PublicKey, verifySignedManifest } from './download/integrityVerification'
import {
  isNewerVersion,
  parseVerifiedAssetPayload,
  type UpdateReleaseAsset
} from './updaterVersion'

export type UpdateCheckResult = {
  configured: boolean
  currentVersion: string
  latestVersion?: string
  updateAvailable?: boolean
  releaseNotes?: string
  releaseUrl?: string
  publishedAt?: string
  assetUrl?: string
  assetName?: string
  assetSha256?: string
  verificationError?: string
  error?: string
}

type ReleaseAsset = UpdateReleaseAsset & { state?: string }
type GitHubRelease = {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  published_at?: string
  draft?: boolean
  prerelease?: boolean
  assets?: ReleaseAsset[]
}
type VerifiedAsset = { version: string; assetName: string; sha256: string; platform?: string }
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_UPDATE_BYTES = 1024 * 1024 * 1024
const pendingVerifiedUpdates = new Map<string, { path: string; sha256: string; fileName: string }>()

async function readBoundedBody(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > limit) throw new Error(`Response exceeds the ${limit}-byte safety limit.`)
  if (!response.body) throw new Error('Server returned an empty response body.')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      total += chunk.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new Error(`Response exceeds the ${limit}-byte safety limit.`)
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

async function getLatestRelease(
  repository: string
): Promise<{ owner: string; repo: string; release: GitHubRelease }> {
  const match = repository.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (!match) throw new Error('Enter the official GitHub repository as owner/repository.')
  const [, owner, repo] = match
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Speed-o-Freq-Sonic-Updater'
      },
      signal: AbortSignal.timeout(12000)
    }
  )
  if (!response.ok) {
    if (response.status === 404)
      throw new Error(
        'GitHub latest release was not found. Check the repository and publish a non-draft release.'
      )
    if (response.status === 403 || response.status === 429)
      throw new Error('GitHub rate limit reached. Try again later.')
    throw new Error(`Update check failed (HTTP ${response.status}).`)
  }
  const release = (await response.json()) as GitHubRelease
  const version = (release.tag_name ?? '').replace(/^v/i, '')
  if (
    !version ||
    release.draft ||
    release.prerelease ||
    !release.html_url?.startsWith('https://github.com/')
  )
    throw new Error('GitHub returned an invalid or non-stable release record.')
  return { owner, repo, release }
}

async function getVerifiedAsset(
  release: GitHubRelease,
  publicKeyPem: string,
  expectedFingerprint: string
): Promise<{ asset: ReleaseAsset; verified: VerifiedAsset }> {
  const fingerprint = fingerprintEd25519PublicKey(publicKeyPem)
  if (
    !/^[a-f0-9]{64}$/i.test(expectedFingerprint) ||
    fingerprint !== expectedFingerprint.trim().toLowerCase()
  )
    throw new Error('Pinned publisher fingerprint does not match the supplied Ed25519 key.')
  const assets = release.assets ?? []
  const manifestAsset = assets.find(
    (asset) =>
      asset.name === 'sonic-update-manifest.json' &&
      asset.browser_download_url?.startsWith('https://github.com/')
  )
  if (!manifestAsset?.browser_download_url)
    throw new Error('Release has no sonic-update-manifest.json; no installer can be trusted.')
  const response = await fetch(manifestAsset.browser_download_url, {
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'Speed-o-Freq-Sonic-Updater' }
  })
  if (!response.ok)
    throw new Error(`Signed update manifest download failed (HTTP ${response.status}).`)
  const manifestBytes = await readBoundedBody(response, MAX_MANIFEST_BYTES)
  const manifestText = manifestBytes.toString('utf8')
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestText)
  } catch {
    throw new Error('Signed update manifest is not valid JSON.')
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error('Signed update manifest must be a JSON object.')
  const checked = verifySignedManifest(
    manifest as { payload: string; signature: string; keyId?: string },
    publicKeyPem
  )
  if (!checked.valid)
    throw new Error('Publisher signature is invalid; installer download is blocked.')
  if (checked.publicKeyFingerprint !== expectedFingerprint.trim().toLowerCase())
    throw new Error('Publisher fingerprint changed; installer download is blocked.')
  const verified = parseVerifiedAssetPayload(
    checked.payload,
    release.tag_name ?? '',
    assets as UpdateReleaseAsset[]
  ) as VerifiedAsset
  const asset = assets.find((candidate) => candidate.name === verified.assetName)
  if (!asset?.browser_download_url) throw new Error('Verified installer URL is missing.')
  return { asset, verified }
}

/** Checks stable releases. Installer details are returned only after a pinned-key signature validates. */
export async function checkForUpdate(
  repository: string,
  publicKeyPem?: string,
  expectedFingerprint?: string
): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  const { release } = await getLatestRelease(repository)
  const latestVersion = (release.tag_name ?? '').replace(/^v/i, '')
  const result: UpdateCheckResult = {
    configured: true,
    currentVersion,
    latestVersion,
    updateAvailable: isNewerVersion(latestVersion, currentVersion),
    releaseNotes: (release.body ?? '').slice(0, 20000),
    releaseUrl: release.html_url,
    ...(release.published_at ? { publishedAt: release.published_at } : {})
  }
  if (!result.updateAvailable) return result
  if (!publicKeyPem || !expectedFingerprint) {
    result.verificationError =
      'Pin the publisher Ed25519 key using an independently verified SHA-256 fingerprint before downloading an update.'
    return result
  }
  const { asset, verified } = await getVerifiedAsset(release, publicKeyPem, expectedFingerprint)
  if (!asset.browser_download_url?.startsWith('https://github.com/'))
    throw new Error('Installer URL is not hosted on GitHub.')
  return {
    ...result,
    assetUrl: asset.browser_download_url,
    assetName: verified.assetName,
    assetSha256: verified.sha256
  }
}

/** Downloads only an installer covered by a valid manifest signature from the pinned publisher key. */
export async function downloadVerifiedUpdate(
  repository: string,
  publicKeyPem: string,
  expectedFingerprint: string
): Promise<{ operationId: string; fileName: string; sha256: string }> {
  const { release } = await getLatestRelease(repository)
  const version = (release.tag_name ?? '').replace(/^v/i, '')
  if (!isNewerVersion(version, app.getVersion()))
    throw new Error('There is no newer stable release to download.')
  const { asset, verified } = await getVerifiedAsset(release, publicKeyPem, expectedFingerprint)
  const url = asset.browser_download_url
  if (!url?.startsWith('https://github.com/'))
    throw new Error('Installer URL is not hosted on GitHub.')
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120000),
    headers: { 'User-Agent': 'Speed-o-Freq-Sonic-Updater' }
  })
  if (!response.ok) throw new Error(`Installer download failed (HTTP ${response.status}).`)
  if (typeof asset.size === 'number' && asset.size > MAX_UPDATE_BYTES)
    throw new Error('Update installer exceeds the 1 GiB safety limit.')
  const bytes = await readBoundedBody(response, MAX_UPDATE_BYTES)
  if (bytes.byteLength === 0) throw new Error('Downloaded installer is empty.')
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== verified.sha256)
    throw new Error(
      `Installer SHA-256 mismatch. Expected ${verified.sha256}; got ${actual}. File was not staged.`
    )
  const safeName = basename(verified.assetName).replace(/[^A-Za-z0-9._-]/g, '_')
  const directory = join(app.getPath('userData'), 'verified-updates')
  await mkdir(directory, { recursive: true })
  const operationId = randomUUID()
  const path = join(directory, `${operationId}-${safeName}`)
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  pendingVerifiedUpdates.set(operationId, { path, sha256: actual, fileName: safeName })
  return { operationId, fileName: safeName, sha256: actual }
}

/** Explicitly opens a previously verified installer; it never launches an arbitrary renderer path. */
export async function openVerifiedUpdate(
  operationId: string
): Promise<{ opened: boolean; error?: string }> {
  const pending = pendingVerifiedUpdates.get(operationId)
  if (!pending)
    throw new Error(
      'Verified installer session was not found. Download and verify the update again.'
    )
  const bytes = await readFile(pending.path)
  if (createHash('sha256').update(bytes).digest('hex') !== pending.sha256) {
    pendingVerifiedUpdates.delete(operationId)
    throw new Error('Staged installer changed after verification. It will not be opened.')
  }
  const error = await shell.openPath(pending.path)
  if (error) return { opened: false, error }
  pendingVerifiedUpdates.delete(operationId)
  return { opened: true }
}
