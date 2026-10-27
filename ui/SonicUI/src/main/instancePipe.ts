import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

/**
 * Test launches use a private user-data directory. Give each one its own local pipes so an
 * already-open desktop app or another test cannot steal its requests. Packaged builds always
 * use the stable public endpoint expected by SpeedOFreq.Cli.exe.
 */
export function instancePipeSuffix(): string {
  // If the CLI is pointed at an isolated profile, both packaged and development
  // instances must derive the same pipe suffix from SONIC_USER_DATA.
  const userData = process.env['SONIC_USER_DATA']
  if (!userData) return ''

  const resolved = resolve(userData)
  const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 12)
  return `.test-${hash}`
}
