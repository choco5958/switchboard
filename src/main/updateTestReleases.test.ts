// The update check's own releases (scripts/tauri-update-check.ts), in a file of its own: setting them
// changes this module's state for the rest of the file.
import { generateKeyPairSync, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { allowedUrl, releaseUrl } from './macUpdate'
import { latestSigned, signedBy, UPDATE_KEYS, useTestReleases } from './updateSignature'

const LATEST = `version: 0.4.0
files:
  - url: Switchboard-0.4.0-win-x64.exe
    sha512: eA==
    size: 1
path: Switchboard-0.4.0-win-x64.exe
sha512: eA==
releaseDate: '2026-11-04T00:00:00.000Z'
`

it('takes the releases and the key of a local server, and nothing else', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pub = String(publicKey.export({ type: 'spki', format: 'pem' }))
  const sig = sign(null, Buffer.from(LATEST), privateKey).toString('base64')
  expect(allowedUrl('https://github.com/choco5958/switchboard/releases/download/v0.4.0/latest.yml')).toBe(true)
  expect(allowedUrl('https://github.com:8443/x')).toBe(false)
  expect(() => useTestReleases('http://127.0.0.1:8443', pub)).toThrow(/not a releases origin/)

  useTestReleases('https://127.0.0.1:8443', pub)
  expect(releaseUrl('0.4.0', 'latest.yml')).toBe('https://127.0.0.1:8443/releases/download/v0.4.0/latest.yml')
  expect(allowedUrl('https://127.0.0.1:8443/releases/download/v0.4.0/latest.yml')).toBe(true)
  expect(allowedUrl('https://127.0.0.1/releases/download/v0.4.0/latest.yml')).toBe(false)
  expect(allowedUrl('https://github.com/choco5958/switchboard/releases/download/v0.4.0/latest.yml')).toBe(false)

  const asked: string[] = []
  const fetch = async (url: string) => {
    asked.push(url)
    if (url.endsWith('.sig')) return Buffer.from(sig)
    return Buffer.from(LATEST)
  }
  expect((await latestSigned('latest.yml', fetch)).version).toBe('0.4.0')
  expect(asked).toEqual([
    'https://127.0.0.1:8443/releases/latest/download/latest.yml',
    'https://127.0.0.1:8443/releases/download/v0.4.0/latest.yml',
    'https://127.0.0.1:8443/releases/download/v0.4.0/latest.yml.sig',
  ])
  // The project's own keys no longer count.
  expect(UPDATE_KEYS.some(pem => signedBy(Buffer.from(LATEST), sig, [pem]))).toBe(false)
  expect(signedBy(Buffer.from(LATEST), sig)).toBe(true)
})
