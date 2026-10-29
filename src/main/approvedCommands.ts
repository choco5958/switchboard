// Dev server commands the person agreed to run. A session can name a dev server's folder and
// command through open_in_ide, so the first run of each command (and of each change to it)
// waits for a yes in the app's own dialog, which no page and no session can answer. Kept as
// hashes of folder and command in a file only the app writes.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function commandKey(folder: string, command: string): string {
  return createHash('sha256').update(`${folder}\0${command}`).digest('hex')
}

export function loadApproved(file: string): Set<string> {
  try {
    const list = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveApproved(file: string, keys: Set<string>): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify([...keys]), { mode: 0o600 })
}
