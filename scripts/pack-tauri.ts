// The Windows and Linux release files of the Tauri app (docs/tauri-이전.md, step 8), made from what
// `tauri build --target <triple>` left, under the names the Electron release used, so an installed
// app of either kind updates from them (electron-updater, or src/main/installUpdate.ts):
//   Windows  Switchboard-<v>-win-<x64|arm64>.exe              latest.yml (the x64 installer first)
//   Linux    Switchboard-<v>-linux-<x86_64|arm64>.AppImage    latest-linux.yml, latest-linux-arm64.yml
//            Switchboard-<v>-linux-<amd64|arm64>.deb
// The release workflow signs the update files (scripts/sign-update.ts). macOS: pack-tauri-mac.ts.
//
//   node scripts/pack-tauri.ts win32 <out>          both architectures, built on one Windows
//   node scripts/pack-tauri.ts linux <x64|arm64> <out>

import { copyFileSync, existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, type Packed } from './pack-tauri-mac.ts'

const ROOT = resolve(import.meta.dirname, '..')

export const TRIPLES = {
  win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
  linux: { x64: 'x86_64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu' },
} as const

// electron-builder's update file: the files, the first as `path` (the one electron-updater
// installs on Windows, and on Linux the AppImage).
export function updateFile(version: string, files: readonly Packed[], date: Date): string {
  const main = files[0]
  if (!main) throw new Error('nothing to update from')
  const lines = [`version: ${version}`, 'files:']
  for (const one of files) lines.push(`  - url: ${one.url}`, `    sha512: ${one.sha512}`, `    size: ${one.size}`)
  lines.push(`path: ${main.url}`, `sha512: ${main.sha512}`, `releaseDate: '${date.toISOString()}'`)
  return `${lines.join('\n')}\n`
}

// The one file tauri build made in that bundle folder.
function built(root: string, triple: string, bundle: string, extension: string): string {
  const dir = join(root, 'src-tauri', 'target', triple, 'release', 'bundle', bundle)
  const found = existsSync(dir) ? globSync(`*.${extension}`, { cwd: dir }) : []
  if (found.length !== 1) throw new Error(`${dir}: ${found.length} .${extension} files, run tauri build --target ${triple} --bundles ${bundle}`)
  return join(dir, found[0]!)
}

function copyAs(from: string, out: string, name: string): Packed {
  copyFileSync(from, join(out, name))
  return describe(join(out, name), name)
}

export function packWindows(out: string, root = ROOT): string[] {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string
  mkdirSync(out, { recursive: true })
  const packed = (['x64', 'arm64'] as const).map(arch => copyAs(built(root, TRIPLES.win32[arch], 'nsis', 'exe'), out, `Switchboard-${version}-win-${arch}.exe`))
  writeFileSync(join(out, 'latest.yml'), updateFile(version, packed, new Date()))
  return [...packed.map(one => one.url), 'latest.yml']
}

export function packLinux(arch: 'x64' | 'arm64', out: string, root = ROOT): string[] {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string
  mkdirSync(out, { recursive: true })
  const triple = TRIPLES.linux[arch]
  const packed = [
    copyAs(built(root, triple, 'appimage', 'AppImage'), out, `Switchboard-${version}-linux-${arch === 'x64' ? 'x86_64' : 'arm64'}.AppImage`),
    copyAs(built(root, triple, 'deb', 'deb'), out, `Switchboard-${version}-linux-${arch === 'x64' ? 'amd64' : 'arm64'}.deb`),
  ]
  const file = arch === 'x64' ? 'latest-linux.yml' : 'latest-linux-arm64.yml'
  writeFileSync(join(out, file), updateFile(version, packed, new Date()))
  return [...packed.map(one => one.url), file]
}

if (import.meta.main) {
  const [system, ...rest] = process.argv.slice(2)
  let names: string[] | null = null
  if (system === 'win32' && rest[0]) names = packWindows(resolve(rest[0]))
  else if (system === 'linux' && (rest[0] === 'x64' || rest[0] === 'arm64') && rest[1]) names = packLinux(rest[0], resolve(rest[1]))
  if (!names) {
    console.error('usage: node scripts/pack-tauri.ts win32 <out> | linux <x64|arm64> <out>')
    process.exit(2)
  }
  for (const name of names) console.log(name)
}
