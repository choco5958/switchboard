// The macOS release files of the Tauri app (docs/tauri-이전.md, step 7), made from the bundles
// `tauri build --target <triple>` left, under the names the Electron release used, so an
// installed app of either kind updates from them (src/main/updateFlow.ts macUpdates):
//   Switchboard-<version>-mac-<arch>.zip   what an update downloads and swaps in
//   Switchboard-<version>-mac-<arch>.dmg   what a person downloads
//   latest-mac.yml                         the update file, as electron-builder writes it (the
//                                          release workflow signs it, scripts/sign-update.ts)
// The disk image is made with hdiutil alone: no Finder window opens, here or on CI.
//
//   node scripts/pack-tauri-mac.ts <out>

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

// Rust's target triples to the names in the release files.
export const MAC_ARCHES = { 'aarch64-apple-darwin': 'arm64', 'x86_64-apple-darwin': 'x64' } as const

// The Tauri app asks for macOS 13.5, its Node's minimum (tauri.conf.json minimumSystemVersion).
// electron-updater compares this with os.release(), the Darwin version: 22.6 is macOS 13.5. An
// Electron app on an older macOS then stays on its version instead of installing one that will
// not open there.
export const MINIMUM_DARWIN = '22.6.0'

export type Packed = { url: string; sha512: string; size: number }

export function describe(path: string, url: string): Packed {
  return { url, sha512: createHash('sha512').update(readFileSync(path)).digest('base64'), size: statSync(path).size }
}

// latest-mac.yml in electron-builder's shape (src/main/updateSignature.ts parseUpdateFile reads
// exactly this): the zips first, the x64 zip as `path`.
export function updateFile(version: string, files: readonly Packed[], date: Date): string {
  const order = (one: Packed) => (one.url.endsWith('.zip') ? 0 : 2) + (one.url.includes('-x64.') ? 0 : 1)
  const sorted = [...files].sort((a, b) => order(a) - order(b))
  const main = sorted[0]
  if (!main || !main.url.endsWith('.zip')) throw new Error('no zip to update from')
  const lines = [`version: ${version}`, 'files:']
  for (const one of sorted) lines.push(`  - url: ${one.url}`, `    sha512: ${one.sha512}`, `    size: ${one.size}`)
  lines.push(`path: ${main.url}`, `sha512: ${main.sha512}`, `minimumSystemVersion: ${MINIMUM_DARWIN}`, `releaseDate: '${date.toISOString()}'`)
  return `${lines.join('\n')}\n`
}

export function packMac(out: string, root = ROOT): string[] {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string
  mkdirSync(out, { recursive: true })
  const packed: Packed[] = []
  for (const [triple, arch] of Object.entries(MAC_ARCHES)) {
    const app = join(root, 'src-tauri', 'target', triple, 'release', 'bundle', 'macos', 'Switchboard.app')
    if (!existsSync(app)) throw new Error(`${app} is missing: run tauri build --target ${triple}`)
    const shown = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
    if (shown !== version) throw new Error(`${app} is ${shown}, package.json says ${version}`)
    // The check an installed app makes before it swaps (macUpdate.ts unpack).
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
    const zip = join(out, `Switchboard-${version}-mac-${arch}.zip`)
    rmSync(zip, { force: true })
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip])
    packed.push(describe(zip, `Switchboard-${version}-mac-${arch}.zip`))
    const folder = mkdtempSync(join(tmpdir(), 'sb-dmg-'))
    try {
      execFileSync('/usr/bin/ditto', [app, join(folder, 'Switchboard.app')])
      symlinkSync('/Applications', join(folder, 'Applications'))
      const dmg = join(out, `Switchboard-${version}-mac-${arch}.dmg`)
      rmSync(dmg, { force: true })
      execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-volname', 'Switchboard', '-srcfolder', folder, '-fs', 'HFS+', '-format', 'UDZO', '-ov', dmg])
      packed.push(describe(dmg, `Switchboard-${version}-mac-${arch}.dmg`))
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  }
  writeFileSync(join(out, 'latest-mac.yml'), updateFile(version, packed, new Date()))
  return [...packed.map(one => one.url), 'latest-mac.yml']
}

if (import.meta.main) {
  const out = process.argv[2]
  if (!out) {
    console.error('usage: node scripts/pack-tauri-mac.ts <out>')
    process.exit(2)
  }
  for (const name of packMac(resolve(out))) console.log(name)
}
