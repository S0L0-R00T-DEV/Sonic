export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (value: string): number[] | null => {
    const normalized = value.trim().replace(/^v/i, '').split('-')[0]
    if (!/^\d+(\.\d+){1,3}$/.test(normalized)) return null
    return normalized.split('.').map(Number)
  }
  const next = parse(candidate)
  const installed = parse(current)
  if (!next || !installed) return false
  for (let i = 0; i < Math.max(next.length, installed.length); i++) {
    const a = next[i] ?? 0
    const b = installed[i] ?? 0
    if (a !== b) return a > b
  }
  return false
}

export type UpdateReleaseAsset = { name?: string; browser_download_url?: string; size?: number }
export type VerifiedUpdateAsset = {
  version: string
  assetName: string
  sha256: string
  platform?: string
}

/** Validates the signed release payload against the published release assets before a download. */
export function parseVerifiedAssetPayload(
  payload: string,
  releaseVersion: string,
  assets: UpdateReleaseAsset[],
  platform = process.platform
): VerifiedUpdateAsset {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw new Error('Signed update payload is not valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Signed update payload must be a JSON object.')
  const item = parsed as Record<string, unknown>
  if (
    typeof item.version !== 'string' ||
    item.version.replace(/^v/i, '') !== releaseVersion.replace(/^v/i, '')
  )
    throw new Error('Signed update version does not match the GitHub release tag.')
  if (
    typeof item.assetName !== 'string' ||
    item.assetName.length > 240 ||
    /[\\/]/.test(item.assetName) ||
    item.assetName === '.' ||
    item.assetName === '..'
  )
    throw new Error('Signed update manifest contains an invalid asset name.')
  if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256))
    throw new Error('Signed update manifest must include a 64-character SHA-256 digest.')
  if (item.platform !== platform)
    throw new Error('Signed update manifest must explicitly target this operating system.')
  const asset = assets.find(
    (candidate) =>
      candidate.name === item.assetName &&
      candidate.browser_download_url?.startsWith('https://github.com/')
  )
  if (!asset)
    throw new Error('The signed installer is not present as a GitHub-hosted release asset.')
  if (typeof asset.size === 'number' && asset.size > 1024 * 1024 * 1024)
    throw new Error('Update installer exceeds the 1 GiB safety limit.')
  return {
    version: item.version,
    assetName: item.assetName,
    sha256: item.sha256.toLowerCase(),
    platform: item.platform as string
  }
}
