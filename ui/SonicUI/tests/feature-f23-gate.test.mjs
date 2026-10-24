import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JavaScript test file
const read = (path) => readFileSync(join(root, path), 'utf8')

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JavaScript test file
function filesUnder(directory) {
  const found = []
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(path))
    else if (/\.(?:ts|tsx|js|mjs|json)$/.test(entry.name)) found.push(path)
  }
  return found
}

test('peer-assisted HTTP sharing is out of scope and torrent HTTP web seeds stay disabled', () => {
  const review = read('docs/feature-F23-security-review.md')
  assert.match(
    review,
    /Disposition: \*\*peer-assisted HTTP sharing is removed from product scope\*\*/
  )
  assert.match(
    review,
    /No peer-assisted HTTP uploader, HTTP sharing listener, peer discovery service, or peer-assisted tracker is implemented/
  )
  assert.match(review, /Do not reintroduce this feature without a new explicit product decision/)

  const activeSource = filesUnder('src')
  const peerImplementation = activeSource.filter((path) =>
    /(?:peer.?sharing|peer.?assisted.?http|http.?seeding|share.?tracker)/i.test(
      relative(root, path)
    )
  )
  assert.deepEqual(peerImplementation, [], 'No peer-assisted HTTP implementation modules may exist')

  const sourceText = activeSource
    .filter((path) => !path.endsWith('.d.ts'))
    .map((path) => read(path))
    .join('\n')
  assert.doesNotMatch(
    sourceText,
    /(?:startPeerHttpSeed|createPeerSharingServer|enablePeerAssistedHttp)/i
  )
  assert.match(sourceText, /webSeeds:\s*false/)
  assert.match(sourceText, /natUpnp:\s*false/)
  assert.match(sourceText, /natPmp:\s*false/)
  assert.match(sourceText, /lsd:\s*false/)

  const engine = read('src/main/download/torrent/engine.ts')
  assert.ok(
    engine.indexOf('...options') < engine.indexOf('webSeeds: false'),
    'Caller options must not be able to override the web-seed transport boundary'
  )
  assert.equal(existsSync(join(root, 'src/main/download/peerSharingServer.ts')), false)
})
