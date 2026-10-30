// The key the app proves itself to the bridge with (bridge/server.ts appOnly). Kept encrypted
// by the system's keychain (Electron safeStorage), so the app finds the same key after a
// restart and the bridge it left running keeps answering it; where no keychain is
// available it lives for one run of the app. The bridge gets it on standard input only.

import { safeStorage } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

// What loadAppKey uses of safeStorage, so tests can stand in for it.
export type KeyStorage = Pick<typeof safeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'> & {
  getSelectedStorageBackend?: () => string
}

// Whether the keychain really encrypts. On Linux without a secret service (no GNOME keyring
// or KWallet) safeStorage falls back to 'basic_text', a key written in Chromium's own code:
// anyone who can read the file can decrypt it. That counts as no keychain, so the key lives
// for one run instead of sitting in a file in a form any program of the person can undo.
export function realEncryption(storage: KeyStorage, platform: string = process.platform): boolean {
  if (!storage.isEncryptionAvailable()) return false
  return platform !== 'linux' || storage.getSelectedStorageBackend?.() !== 'basic_text'
}

// `refused`: the keychain would not give its secret (the person said no to its question). The
// saved file stays for a later start that is allowed, and this run uses a key of its own, which
// means the app starts its bridge again (every session's stream drops once).
export function loadAppKey(file: string, storage: KeyStorage = safeStorage, platform: string = process.platform): { key: string; refused: boolean } {
  if (!realEncryption(storage, platform)) return { key: randomBytes(32).toString('hex'), refused: false }
  if (existsSync(file)) {
    try {
      const key = storage.decryptString(readFileSync(file))
      if (/^[0-9a-f]{64}$/.test(key)) return { key, refused: false }
    } catch {
      // Made by another install, or the keychain said no: writing a new key tells which.
    }
  }
  const key = randomBytes(32).toString('hex')
  let sealed: Buffer
  try {
    sealed = storage.encryptString(key)
  } catch {
    return { key, refused: true }
  }
  try {
    writeFileSync(file, sealed, { mode: 0o600 })
  } catch {
    // Kept for this run only.
  }
  return { key, refused: false }
}
