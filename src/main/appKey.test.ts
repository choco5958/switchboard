import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { loadAppKey, realEncryption, type KeyStorage } from './appKey'

// The real module would install Electron's binary while the tests run, and two workers doing
// that at once collide (CI). Every test here passes its own storage.
vi.mock('electron', () => ({ safeStorage: {} }))

const dir = mkdtempSync(join(tmpdir(), 'sb-key-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// A keychain that "encrypts" by reversing, with the backend Linux reports.
const storage = (backend?: string, available = true): KeyStorage => ({
  isEncryptionAvailable: () => available,
  encryptString: text => Buffer.from([...text].reverse().join('')),
  decryptString: data => [...data.toString()].reverse().join(''),
  ...(backend ? { getSelectedStorageBackend: () => backend } : {}),
})

describe('the app key', () => {
  it("Linux's basic_text backend counts as no encryption", () => {
    expect(realEncryption(storage('basic_text'), 'linux')).toBe(false)
    expect(realEncryption(storage('gnome_libsecret'), 'linux')).toBe(true)
    expect(realEncryption(storage('kwallet5'), 'linux')).toBe(true)
    expect(realEncryption(storage(), 'darwin')).toBe(true)
    expect(realEncryption(storage(undefined, false), 'win32')).toBe(false)
  })

  it('is saved and found again with a real keychain, and lives one run without one', () => {
    const saved = join(dir, 'kept.bin')
    const first = loadAppKey(saved, storage('gnome_libsecret'), 'linux')
    expect(first.key).toMatch(/^[0-9a-f]{64}$/)
    expect(loadAppKey(saved, storage('gnome_libsecret'), 'linux').key).toBe(first.key)

    const plain = join(dir, 'plain.bin')
    const once = loadAppKey(plain, storage('basic_text'), 'linux')
    expect(once).toMatchObject({ refused: false })
    expect(existsSync(plain)).toBe(false)
    expect(loadAppKey(plain, storage('basic_text'), 'linux').key).not.toBe(once.key)
  })
})
