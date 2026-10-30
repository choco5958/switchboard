import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { allowedUrl, BUNDLE_ID, bundleOf, canReplace, cleanUpdates, fetchSmall, fileMatches, isNewer, releaseUrl, SWAP_SCRIPT, swapArgs, unpack, zipFor } from './macUpdate'

const root = mkdtempSync(join(tmpdir(), 'sb-macupdate-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// A pid that no process has any more: a child that has exited.
const gonePid = () => spawnSync('true').pid!

describe('macOS updates', () => {
  it('installs only a newer x.y.z, never a prerelease or an older version', () => {
    expect(isNewer('0.3.5', '0.3.4')).toBe(true)
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('1.0.0', '0.99.99')).toBe(true)
    expect(isNewer('0.3.4', '0.3.4')).toBe(false)
    expect(isNewer('0.3.3', '0.3.4')).toBe(false)
    expect(isNewer('0.4.0-beta.1', '0.3.4')).toBe(false)
    expect(isNewer('v0.4.0', '0.3.4')).toBe(false)
    // A prerelease build running gets the release of its version.
    expect(isNewer('0.4.0', '0.4.0-beta.1')).toBe(true)
  })

  it('picks the zip for the chip from latest-mac.yml, by its exact name', () => {
    const files = [
      { url: 'Switchboard-0.3.5-mac-x64.zip', sha512: 'x64sum', size: 127 },
      { url: 'Switchboard-0.3.5-mac-arm64.zip', sha512: 'armsum', size: 119 },
      { url: 'Switchboard-0.3.5-mac-arm64.dmg', sha512: 'dmgsum', size: 123 },
    ]
    expect(zipFor(files, '0.3.5', 'arm64')).toEqual({ name: 'Switchboard-0.3.5-mac-arm64.zip', sha512: 'armsum', size: 119 })
    expect(zipFor(files, '0.3.5', 'x64')).toEqual({ name: 'Switchboard-0.3.5-mac-x64.zip', sha512: 'x64sum', size: 127 })
    expect(zipFor(files, '0.3.5', 'ia32')).toBe(null)
    expect(zipFor(files, '0.3.6', 'arm64')).toBe(null)
    expect(zipFor([{ url: 'Switchboard-0.3.5-mac-arm64.zip', size: 119 }], '0.3.5', 'arm64')).toBe(null)
    expect(zipFor([{ url: 'Switchboard-0.3.5-mac-arm64.zip', sha512: 'a', size: 0 }], '0.3.5', 'arm64')).toBe(null)
    expect(zipFor([{ url: '../Switchboard-0.3.5-mac-arm64.zip', sha512: 'a', size: 1 }], '0.3.5', 'arm64')).toBe(null)
    expect(releaseUrl('0.3.5', 'Switchboard-0.3.5-mac-arm64.zip')).toBe('https://github.com/choco5958/switchboard/releases/download/v0.3.5/Switchboard-0.3.5-mac-arm64.zip')
  })

  it('downloads only over https from GitHub and its file storage', async () => {
    // The update file and its signature come the same way; nothing else is even asked.
    await expect(fetchSmall('http://github.com/choco5958/switchboard/releases/download/v0.3.5/latest.yml', 1024)).rejects.toThrow(/refused/)
    await expect(fetchSmall('https://evil.example/latest.yml', 1024)).rejects.toThrow(/refused/)
    expect(allowedUrl('https://github.com/choco5958/switchboard/releases/download/v0.3.5/a.zip')).toBe(true)
    expect(allowedUrl('https://objects.githubusercontent.com/github-production-release-asset/1?x=1')).toBe(true)
    expect(allowedUrl('https://release-assets.githubusercontent.com/github-production-release-asset/1')).toBe(true)
    expect(allowedUrl('http://github.com/a.zip')).toBe(false)
    expect(allowedUrl('https://github.com.evil.example/a.zip')).toBe(false)
    expect(allowedUrl('https://evil.example/github.com')).toBe(false)
    expect(allowedUrl('https://user:pw@github.com/a.zip')).toBe(false)
    expect(allowedUrl('https://github.com:8443/a.zip')).toBe(false)
    expect(allowedUrl('not a url')).toBe(false)
  })

  it('finds the bundle around the executable, and whether this user can replace it', () => {
    expect(bundleOf('/Applications/Switchboard.app/Contents/MacOS/Switchboard')).toBe('/Applications/Switchboard.app')
    expect(bundleOf('/Users/me/dev/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')).toBe('/Users/me/dev/node_modules/electron/dist/Electron.app')
    expect(bundleOf('/opt/Switchboard/switchboard')).toBe(null)
    const bundle = join(root, 'writable', 'Switchboard.app')
    mkdirSync(bundle, { recursive: true })
    expect(canReplace(bundle)).toBe(true)
    expect(canReplace(join(root, 'missing', 'Switchboard.app'))).toBe(false)
  })

  it('keeps a download only when its size and sha512 match latest-mac.yml', async () => {
    const file = join(root, 'download.zip')
    writeFileSync(file, 'the release zip')
    const sha512 = createHash('sha512').update('the release zip').digest('base64')
    expect(await fileMatches(file, 15, sha512)).toBe(true)
    expect(await fileMatches(file, 16, sha512)).toBe(false)
    expect(await fileMatches(file, 15, createHash('sha512').update('another zip').digest('base64'))).toBe(false)
  })

  it('clears what an earlier run left, but not a failed version or an app it could not put back', () => {
    const dir = join(root, 'updates-clean')
    mkdirSync(join(dir, '0.3.5', 'Switchboard.app'), { recursive: true })
    mkdirSync(join(dir, '0.3.6', 'old.app'), { recursive: true })
    writeFileSync(join(dir, 'Switchboard-0.3.5-mac-arm64.zip'), 'partial')
    writeFileSync(join(dir, '0.3.7.failed'), 'could not move the app aside')
    writeFileSync(join(dir, '0.3.3.failed'), 'older than this version')
    expect([...cleanUpdates(dir, '0.3.4')]).toEqual(['0.3.7'])
    expect(existsSync(join(dir, '0.3.5'))).toBe(false)
    expect(existsSync(join(dir, 'Switchboard-0.3.5-mac-arm64.zip'))).toBe(false)
    expect(existsSync(join(dir, '0.3.3.failed'))).toBe(false)
    expect(existsSync(join(dir, '0.3.6', 'old.app'))).toBe(true)
    expect(cleanUpdates(join(root, 'no-updates'), '0.3.4').size).toBe(0)
  })
})

describe('the swap script', () => {
  // Paths with a quote, spaces and a command substitution: they reach the script as arguments only.
  const setup = (name: string) => {
    const base = join(root, `${name} it's $(touch pwned)`)
    const target = join(base, 'Applications', 'Switchboard.app')
    const stage = join(base, 'updates', '0.3.5')
    const fresh = join(stage, 'Switchboard.app')
    for (const [bundle, version] of [
      [target, '0.3.4'],
      [fresh, '0.3.5'],
    ] as const) {
      mkdirSync(join(bundle, 'Contents'), { recursive: true })
      writeFileSync(join(bundle, 'Contents', 'version'), version)
    }
    const script = join(stage, 'install.sh')
    writeFileSync(script, SWAP_SCRIPT, { mode: 0o700 })
    const log = join(base, 'update.log')
    return { base, target, stage, fresh, script, log }
  }
  const run = (script: string, args: string[]) => spawnSync('/bin/sh', [script, ...args], { cwd: root, encoding: 'utf8' })

  it('passes everything as positional arguments', () => {
    expect(swapArgs({ pid: 42, target: '/A/S.app', fresh: '/u/0.3.5/S.app', stage: '/u/0.3.5', relaunch: true, log: '/u.log' })).toEqual([
      '42',
      '/A/S.app',
      '/u/0.3.5/S.app',
      '/u/0.3.5',
      '1',
      '/u.log',
    ])
  })

  it('puts the new bundle in place once the app has quit, and clears the staging folder', () => {
    const at = setup('swap')
    const done = run(at.script, swapArgs({ pid: gonePid(), target: at.target, fresh: at.fresh, stage: at.stage, relaunch: false, log: at.log }))
    expect(done.status, readFileSync(at.log, 'utf8')).toBe(0)
    expect(readFileSync(join(at.target, 'Contents', 'version'), 'utf8')).toBe('0.3.5')
    expect(existsSync(at.stage)).toBe(false)
    expect(existsSync(`${at.stage}.failed`)).toBe(false)
    expect(readFileSync(at.log, 'utf8')).toContain('installed')
    expect(existsSync(join(root, 'pwned'))).toBe(false)
  })

  it('waits for the app to exit before it touches the bundle', async () => {
    const at = setup('wait')
    const appProcess = spawn('sleep', ['0.6'])
    const exited = new Promise(resolve => appProcess.on('exit', resolve))
    const swap = spawn('/bin/sh', [at.script, ...swapArgs({ pid: appProcess.pid!, target: at.target, fresh: at.fresh, stage: at.stage, relaunch: false, log: at.log })])
    const swapped = new Promise(resolve => swap.on('exit', resolve))
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(readFileSync(join(at.target, 'Contents', 'version'), 'utf8')).toBe('0.3.4')
    await exited
    expect(await swapped).toBe(0)
    expect(readFileSync(join(at.target, 'Contents', 'version'), 'utf8')).toBe('0.3.5')
  })

  it('puts the old bundle back when the new one cannot move in, and marks the version', () => {
    const at = setup('restore')
    rmSync(at.fresh, { recursive: true })
    const done = run(at.script, swapArgs({ pid: gonePid(), target: at.target, fresh: at.fresh, stage: at.stage, relaunch: false, log: at.log }))
    expect(done.status).toBe(1)
    expect(readFileSync(join(at.target, 'Contents', 'version'), 'utf8')).toBe('0.3.4')
    expect(readFileSync(`${at.stage}.failed`, 'utf8')).toContain('the old one is back')
    expect(existsSync(at.stage)).toBe(false)
  })

  it('changes nothing when the old bundle cannot move aside', () => {
    const at = setup('stuck')
    const done = run(at.script, swapArgs({ pid: gonePid(), target: join(at.base, 'Applications', 'Missing.app'), fresh: at.fresh, stage: at.stage, relaunch: false, log: at.log }))
    expect(done.status).toBe(1)
    expect(readFileSync(join(at.target, 'Contents', 'version'), 'utf8')).toBe('0.3.4')
    expect(readFileSync(`${at.stage}.failed`, 'utf8')).toContain('nothing changed')
  })
})

// ditto, PlistBuddy and codesign exist only on macOS.
describe.skipIf(process.platform !== 'darwin')('unpacking the release zip', () => {
  const tool = (file: string, args: string[]) => {
    const done = spawnSync(file, args, { encoding: 'utf8' })
    if (done.status !== 0) throw new Error(`${file}: ${done.stderr}`)
  }
  // A bundle like the release's: an executable, its Info.plist and an ad hoc signature.
  const makeZip = (name: string, id: string, version: string) => {
    const dir = join(root, name)
    const bundle = join(dir, 'Switchboard.app')
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    copyFileSync('/usr/bin/true', join(bundle, 'Contents', 'MacOS', 'Switchboard'))
    const plist = join(bundle, 'Contents', 'Info.plist')
    tool('/usr/libexec/PlistBuddy', ['-c', 'Add :CFBundleExecutable string Switchboard', '-c', `Add :CFBundleIdentifier string ${id}`, '-c', `Add :CFBundleShortVersionString string ${version}`, plist])
    tool('/usr/bin/codesign', ['--force', '--sign', '-', bundle])
    const zip = join(dir, 'release.zip')
    tool('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, zip])
    return { zip, bundle }
  }

  it('unpacks a bundle of this app at the expected version with an intact signature', async () => {
    const { zip } = makeZip('good', BUNDLE_ID, '0.3.5')
    const fresh = await unpack(zip, join(root, 'good-stage'), '0.3.5')
    expect(fresh).toBe(join(root, 'good-stage', 'Switchboard.app'))
    expect(existsSync(join(fresh, 'Contents', 'MacOS', 'Switchboard'))).toBe(true)
  })

  it('refuses another app, another version or a changed bundle', async () => {
    const other = makeZip('other', 'com.example.other', '0.3.5')
    await expect(unpack(other.zip, join(root, 'other-stage'), '0.3.5')).rejects.toThrow(/com\.example\.other/)
    const older = makeZip('older', BUNDLE_ID, '0.3.4')
    await expect(unpack(older.zip, join(root, 'older-stage'), '0.3.5')).rejects.toThrow(/0\.3\.4/)
    const changed = makeZip('changed', BUNDLE_ID, '0.3.5')
    writeFileSync(join(changed.bundle, 'Contents', 'MacOS', 'Switchboard'), '#!/bin/sh\n')
    rmSync(changed.zip)
    tool('/usr/bin/ditto', ['-c', '-k', '--keepParent', changed.bundle, changed.zip])
    await expect(unpack(changed.zip, join(root, 'changed-stage'), '0.3.5')).rejects.toThrow(/codesign/)
  })
})
