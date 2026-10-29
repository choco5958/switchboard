// The key the app proves itself to the bridge with (bridge/server.ts appOnly). Kept encrypted
// by the system's keychain (Electron safeStorage), so the app finds the same key after a
// restart and the bridge it left running keeps answering it; where no keychain is
// available it lives for one run of the app. The bridge gets it on standard input only.

import { safeStorage } from 'electron'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

export function loadAppKey(file: string): string {
  if (!safeStorage.isEncryptionAvailable()) return randomBytes(32).toString('hex')
  try {
    const key = safeStorage.decryptString(readFileSync(file))
    if (/^[0-9a-f]{64}$/.test(key)) return key
  } catch {
    // None yet, or made by another install: a new one.
  }
  const key = randomBytes(32).toString('hex')
  try {
    writeFileSync(file, safeStorage.encryptString(key), { mode: 0o600 })
  } catch {
    // Kept for this run only.
  }
  return key
}
