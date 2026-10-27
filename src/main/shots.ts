import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Element shots for screen comments. They can show anything on screen, so only
// this user may read them: the folder is 0700 and each file 0600.
export function saveShot(dir: string, dataUrl: unknown, now = new Date()): string | null {
  if (typeof dataUrl !== 'string') return null
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  if (!match?.[1]) return null
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // An older app made the folder with the default mode.
  chmodSync(dir, 0o700)
  const file = join(dir, `${now.toISOString().replace(/[:.]/g, '-')}.png`)
  writeFileSync(file, Buffer.from(match[1], 'base64'), { mode: 0o600 })
  return file
}
