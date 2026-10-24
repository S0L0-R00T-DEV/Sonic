import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { app } from 'electron'

/**
 * Test launches use a private user-data directory. Give each one its own local pipes so an
 * already-open desktop app or another test cannot steal its requests. Packaged builds always
 * use the stable public endpoint expected by SpeedOFreq.Cli.exe.
 */
export function instancePipeSuffix(): string {
  const userData = !app.isPackaged ? process.env['SONIC_USER_DATA'] : undefined
  if (!userData) return ''

  const resolved = resolve(userData)
  const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 12)
  return `.test-${hash}`
}
