import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'

async function addFile(hash: ReturnType<typeof createHash>, path: string): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
}

/** Hash a completed output without loading it all into memory. A folder digest includes each
 * selected relative path and its bytes, sorted by path, so it is deterministic for that tree. */
export async function hashCompletedOutput(
  destinationPath: string,
  downloadedFiles?: string[]
): Promise<{ sha256: string; scope: 'file' | 'tree' }> {
  const hash = createHash('sha256')
  if (!downloadedFiles) {
    await addFile(hash, destinationPath)
    return { sha256: hash.digest('hex'), scope: 'file' }
  }

  for (const relativePath of [...downloadedFiles].sort((a, b) => a.localeCompare(b))) {
    hash.update(relativePath.replace(/[\\\\]/g, '/'))
    hash.update(Buffer.from([0]))
    await addFile(hash, join(destinationPath, relativePath))
    hash.update(Buffer.from([0]))
  }
  return { sha256: hash.digest('hex'), scope: 'tree' }
}
