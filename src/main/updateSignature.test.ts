import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { signUpdates } from '../../scripts/sign-update.ts'
import { channelFile, parseUpdateFile, sameUpdate, signedBy, signedUpdate, UPDATE_KEYS } from './updateSignature'

// electron-updater's own reading of an update file (js-yaml), which parseUpdateFile has to match.
const { parseUpdateInfo } = createRequire(import.meta.url)('electron-updater/out/providers/Provider.js') as {
  parseUpdateInfo: (text: string, file: string, url: string) => unknown
}

const root = mkdtempSync(join(tmpdir(), 'sb-updatesig-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// A key made for the test, and the source that trusts it (scripts/sign-update.ts reads UPDATE_KEYS
// from src/main/updateSignature.ts).
const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { pem: String(privateKey.export({ type: 'pkcs8', format: 'pem' })), pub: String(publicKey.export({ type: 'spki', format: 'pem' })) }
}
const key = pair()
const other = pair()

// latest.yml of 0.3.5 as the release workflow published it.
const LATEST = `version: 0.3.5
files:
  - url: Switchboard-0.3.5-win.exe
    sha512: FReMkgtcHjIebzdSYpTAdRVAZDqgeGlc2P3x+SlfRvzFv45GOItrCi4MExguM68IvbLhagOj3+5mxuuegb/v8A==
    size: 252078335
  - url: Switchboard-0.3.5-win-x64.exe
    sha512: tkihPucjPby7w4wg/KJHHOYGMP2LON8kJskVZ7TsfoZ4Hcz/h6WCNfW/357bkzdj8mKHlb+nQJVPhzjOxVykbA==
    size: 129382709
  - url: Switchboard-0.3.5-win-arm64.exe
    sha512: /NEsqxbAa8JrWXWm15uOCIKRfWTMOzqaEgtTE5msnSJOV21NDhjcIHsGWkwprWwcRrejk0vsuRacYM+bAmNTdw==
    size: 123290705
path: Switchboard-0.3.5-win.exe
sha512: FReMkgtcHjIebzdSYpTAdRVAZDqgeGlc2P3x+SlfRvzFv45GOItrCi4MExguM68IvbLhagOj3+5mxuuegb/v8A==
releaseDate: '2026-10-30T05:30:24.433Z'
`

// latest-linux-arm64.yml of 0.3.5: an AppImage entry carries blockMapSize.
const LINUX = `version: 0.3.5
files:
  - url: Switchboard-0.3.5-linux-arm64.AppImage
    sha512: vbNbbsqFz2SXwIyZr2w/yIpbkCyH8d6pzMi/rcdc7Als9l3XzbgZn6c5R66B+Yn0h86u+v39Rq9nZdPboHXH3w==
    size: 131095093
    blockMapSize: 136577
  - url: Switchboard-0.3.5-linux-arm64.deb
    sha512: XU+1l/YHasiO0ulptQuoKokMWloLFN6SVYp1w6+UCyI2NGeKLd3O9iKgbd/77RclvRA+LdBem6E1oValYsIiLw==
    size: 98475220
path: Switchboard-0.3.5-linux-arm64.AppImage
sha512: vbNbbsqFz2SXwIyZr2w/yIpbkCyH8d6pzMi/rcdc7Als9l3XzbgZn6c5R66B+Yn0h86u+v39Rq9nZdPboHXH3w==
releaseDate: '2026-10-30T05:26:26.332Z'
`

// What electron-updater's GitHub provider makes of LATEST: js-yaml's reading plus the release's
// tag, title and notes.
const found = () => ({
  tag: 'v0.3.5',
  version: '0.3.5',
  files: [
    { url: 'Switchboard-0.3.5-win.exe', sha512: 'FReMkgtcHjIebzdSYpTAdRVAZDqgeGlc2P3x+SlfRvzFv45GOItrCi4MExguM68IvbLhagOj3+5mxuuegb/v8A==', size: 252078335 },
    { url: 'Switchboard-0.3.5-win-x64.exe', sha512: 'tkihPucjPby7w4wg/KJHHOYGMP2LON8kJskVZ7TsfoZ4Hcz/h6WCNfW/357bkzdj8mKHlb+nQJVPhzjOxVykbA==', size: 129382709 },
    { url: 'Switchboard-0.3.5-win-arm64.exe', sha512: '/NEsqxbAa8JrWXWm15uOCIKRfWTMOzqaEgtTE5msnSJOV21NDhjcIHsGWkwprWwcRrejk0vsuRacYM+bAmNTdw==', size: 123290705 },
  ] as { url: string; sha512: string; size: number; isAdminRightsRequired?: boolean }[],
  path: 'Switchboard-0.3.5-win.exe',
  sha512: 'FReMkgtcHjIebzdSYpTAdRVAZDqgeGlc2P3x+SlfRvzFv45GOItrCi4MExguM68IvbLhagOj3+5mxuuegb/v8A==',
  releaseDate: '2026-10-30T05:30:24.433Z',
  releaseName: 'Switchboard v0.3.5',
  releaseNotes: '<p>notes</p>',
})

// Signs `text` as latest.yml the way the release workflow does, and returns the .sig text.
function signed(text: string, pem = key.pem, trusts = key.pub): string {
  const dir = mkdtempSync(join(root, 'sign-'))
  writeFileSync(join(dir, 'latest.yml'), text)
  signUpdates(dir, pem, trusts)
  return readFileSync(join(dir, 'latest.yml.sig'), 'utf8')
}

describe('update signatures', () => {
  it('pins an Ed25519 public key', () => {
    expect(UPDATE_KEYS.length).toBeGreaterThan(0)
    for (const pem of UPDATE_KEYS) {
      const key = createPublicKey(pem)
      expect(key.asymmetricKeyType).toBe('ed25519')
      // Written as Node writes it: scripts/sign-update.ts finds the signing key here by that text.
      expect(String(key.export({ type: 'spki', format: 'pem' })).trim()).toBe(pem)
    }
  })

  it('verifies what the release workflow signs, with any pinned key', () => {
    const sig = signed(LATEST)
    expect(sig).toMatch(/^[A-Za-z0-9+/]{86}==\n$/)
    expect(signedBy(Buffer.from(LATEST), sig, [key.pub])).toBe(true)
    expect(signedBy(Buffer.from(LATEST), sig, [other.pub, key.pub])).toBe(true)
  })

  it('refuses a changed file, another key, and a missing or broken signature', () => {
    const sig = signed(LATEST)
    expect(signedBy(Buffer.from(LATEST.replace('size: 252078335', 'size: 252078336')), sig, [key.pub])).toBe(false)
    expect(signedBy(Buffer.from(LATEST), sig, [other.pub])).toBe(false)
    expect(signedBy(Buffer.from(LATEST), sig, [])).toBe(false)
    expect(signedBy(Buffer.from(LATEST), '', [key.pub])).toBe(false)
    expect(signedBy(Buffer.from(LATEST), 'not a signature', [key.pub])).toBe(false)
    expect(signedBy(Buffer.from(LATEST), `${'A'.repeat(86)}==`, [key.pub])).toBe(false)
    // An RSA key in the list is no Ed25519 key.
    const rsa = String(generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' }))
    expect(signedBy(Buffer.from(LATEST), sig, [rsa, 'not a key'])).toBe(false)
  })

  it('signs only with a key the app trusts, and only when there is something to sign', () => {
    expect(() => signed(LATEST, other.pem, key.pub)).toThrow(/does not trust/)
    expect(() => signUpdates(mkdtempSync(join(root, 'empty-')), key.pem, key.pub)).toThrow(/no latest/)
  })

  it('reads update files as electron-builder writes them, as electron-updater does', () => {
    for (const text of [LATEST, LINUX]) expect(parseUpdateFile(text)).toStrictEqual(parseUpdateInfo(text, 'latest.yml', ''))
    expect(parseUpdateFile(LATEST)).toEqual({ ...found(), tag: undefined, releaseName: undefined, releaseNotes: undefined })
    const linux = parseUpdateFile(LINUX)
    expect(linux.files).toEqual([
      expect.objectContaining({ url: 'Switchboard-0.3.5-linux-arm64.AppImage', size: 131095093, blockMapSize: 136577 }),
      expect.objectContaining({ url: 'Switchboard-0.3.5-linux-arm64.deb', size: 98475220 }),
    ])
    expect(parseUpdateFile("a: 'it''s'\nb: \"x\"\nc: true\nd: -1\n")).toEqual({ a: "it's", b: 'x', c: true, d: -1 })
    expect(() => parseUpdateFile('version: 1\nversion: 2\n')).toThrow(/twice/)
    expect(() => parseUpdateFile('files:\n  - url: a\n    url: b\n')).toThrow(/twice/)
    expect(() => parseUpdateFile('files:\n   - url: a\n')).toThrow(/unexpected/)
    expect(() => parseUpdateFile('- a\n')).toThrow(/unexpected/)
    expect(() => parseUpdateFile('__proto__: x\n')).toThrow(/unexpected/)
  })

  it('accepts what electron-updater found only when it is the signed file', () => {
    const file = parseUpdateFile(LATEST)
    expect(sameUpdate(found(), file)).toBe(true)
    const change = (edit: (info: ReturnType<typeof found>) => void) => {
      const info = found()
      edit(info)
      return sameUpdate(info, file)
    }
    expect(change(info => (info.version = '0.3.6'))).toBe(false)
    expect(change(info => (info.files[1]!.sha512 = info.files[0]!.sha512))).toBe(false)
    expect(change(info => (info.files[1]!.size += 1))).toBe(false)
    expect(change(info => info.files.pop())).toBe(false)
    expect(change(info => info.files.push({ ...info.files[0]!, url: 'Other.exe' }))).toBe(false)
    expect(change(info => (info.files[0]!.isAdminRightsRequired = true))).toBe(false)
    expect(change(info => (info.path = 'Other.exe'))).toBe(false)
    expect(change(info => Object.assign(info, { minimumSystemVersion: '99.0.0' }))).toBe(false)
    // The provider's own fields are not in the file.
    expect(change(info => (info.releaseNotes = 'other'))).toBe(true)
  })

  it('fetches the update file and its signature from the release of the version found', async () => {
    const sig = signed(LATEST)
    const asked: string[] = []
    const fetch = (files: Record<string, string>) => async (url: string, max: number) => {
      asked.push(url)
      const name = url.split('/').pop()!
      if (!(name in files)) throw new Error(`${name} answered 404`)
      expect(max).toBeGreaterThan(files[name]!.length)
      return Buffer.from(files[name]!)
    }
    const good = fetch({ 'latest.yml': LATEST, 'latest.yml.sig': sig })
    const update = await signedUpdate(found(), 'latest.yml', good, [key.pub])
    expect(update.version).toBe('0.3.5')
    expect(update.files.map(one => one.url)).toEqual(['Switchboard-0.3.5-win.exe', 'Switchboard-0.3.5-win-x64.exe', 'Switchboard-0.3.5-win-arm64.exe'])
    expect(asked).toEqual([
      'https://github.com/choco5958/switchboard/releases/download/v0.3.5/latest.yml',
      'https://github.com/choco5958/switchboard/releases/download/v0.3.5/latest.yml.sig',
    ])

    // No signature in the release, one by another key, one of another file.
    await expect(signedUpdate(found(), 'latest.yml', fetch({ 'latest.yml': LATEST }), [key.pub])).rejects.toThrow(/404/)
    await expect(signedUpdate(found(), 'latest.yml', good, [other.pub])).rejects.toThrow(/no valid signature/)
    await expect(signedUpdate(found(), 'latest.yml', fetch({ 'latest.yml': LINUX, 'latest.yml.sig': sig }), [key.pub])).rejects.toThrow(/no valid signature/)
    // Signed, but electron-updater read something else (a latest.yml swapped between the two reads).
    const tampered = found()
    tampered.files[0]!.sha512 = tampered.files[1]!.sha512
    await expect(signedUpdate(tampered, 'latest.yml', good, [key.pub])).rejects.toThrow(/not the one signed/)
    // A signed file of another version under this version's release.
    await expect(signedUpdate({ ...found(), version: '0.3.6', tag: 'v0.3.6' }, 'latest.yml', good, [key.pub])).rejects.toThrow(/not the one signed/)

    // The tag electron-updater downloads from has to be this version's; nothing is fetched otherwise.
    asked.length = 0
    await expect(signedUpdate({ ...found(), tag: 'v0.3.4' }, 'latest.yml', good, [key.pub])).rejects.toThrow(/no signed update/)
    await expect(signedUpdate({ ...found(), version: '0.3.5/../x', tag: 'v0.3.5/../x' }, 'latest.yml', good, [key.pub])).rejects.toThrow(/no signed update/)
    expect(asked).toEqual([])
  })

  it('reads the update file electron-updater reads on each system', () => {
    expect(channelFile('win32', 'x64')).toBe('latest.yml')
    expect(channelFile('win32', 'arm64')).toBe('latest.yml')
    expect(channelFile('darwin', 'arm64')).toBe('latest-mac.yml')
    expect(channelFile('linux', 'x64')).toBe('latest-linux.yml')
    expect(channelFile('linux', 'arm64')).toBe('latest-linux-arm64.yml')
  })
})
