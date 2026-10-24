import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export default async function generateReleaseManifest(buildResult) {
  const outDir = resolve(buildResult.outDir)
  const artifacts = (buildResult.artifactPaths ?? [])
    .filter((file) => typeof file === 'string' && existsSync(file) && statSync(file).isFile())
    .map((file) => ({
      file: basename(file),
      path: relative(outDir, file).replace(/\\/g, '/'),
      sizeBytes: statSync(file).size,
      sha256: sha256(file)
    }))
  if (artifacts.length === 0) {
    throw new Error(
      'afterAllArtifactBuild received no existing artifact paths; release manifest cannot be generated.'
    )
  }

  const sbomPath = join(projectRoot, 'diagnostics', 'sonicui-packaged-sbom.cdx.json')
  if (!existsSync(sbomPath)) {
    throw new Error(
      'The packaged SBOM is missing; refuse to publish a release manifest without it.'
    )
  }
  const manifestPath = join(outDir, 'sonicui-release-manifest.json')
  mkdirSync(outDir, { recursive: true })
  const manifest = {
    schemaVersion: 1,
    product: "Speed-o'-Freq Sonic",
    version: packageJson.version,
    generatedAt: new Date().toISOString(),
    purpose:
      'Release sidecar tying built artifacts to their SHA-256 hashes and the packaged-app CycloneDX SBOM.',
    artifactScope:
      'Hashes installers and other output artifacts after build. The SBOM covers the unpacked app payload and explicitly does not contain an installer-container hash.',
    artifacts,
    sbom: {
      file: 'sonicui-packaged-sbom.cdx.json',
      path: sbomPath,
      sha256: sha256(sbomPath),
      embeddedCopy: 'resources/sonic-sbom.cdx.json'
    }
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log(
    JSON.stringify(
      {
        output: manifestPath,
        artifactsHashed: artifacts.length,
        sbomSha256: manifest.sbom.sha256
      },
      null,
      2
    )
  )
  return [manifestPath]
}
