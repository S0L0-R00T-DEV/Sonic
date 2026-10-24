import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { hashCompletedOutput } from '../src/main/download/outputHash'

test('a file hash matches SHA-256 of the saved bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sonic-output-hash-'))
  try {
    const path = join(dir, 'file.bin')
    const bytes = Buffer.from('Sonic local checksum test')
    await writeFile(path, bytes)
    const result = await hashCompletedOutput(path)
    expect(result.scope).toBe('file')
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a folder hash is deterministic, path-sensitive, and independent of input order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sonic-output-tree-'))
  try {
    await mkdir(join(dir, 'album'))
    await writeFile(join(dir, 'album', 'a.bin'), 'alpha')
    await writeFile(join(dir, 'album', 'b.bin'), 'beta')
    const first = await hashCompletedOutput(join(dir, 'album'), ['b.bin', 'a.bin'])
    const second = await hashCompletedOutput(join(dir, 'album'), ['a.bin', 'b.bin'])
    const changed = await hashCompletedOutput(join(dir, 'album'), ['a.bin'])
    expect(first.scope).toBe('tree')
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(second.sha256).toBe(first.sha256)
    expect(changed.sha256).not.toBe(first.sha256)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
