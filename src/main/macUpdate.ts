// Updates of the macOS app without Squirrel.Mac, which installs only an update signed with a
// developer certificate; this app is signed ad hoc (electron-builder.yml). electron-updater
// still finds the new version (updater.ts); this file downloads the zip of the release for this
// Mac's chip, checks it against latest-mac.yml, unpacks it beside the app's data and, once the
// app has quit, swaps the bundle with a small shell script. Nothing here imports Electron, so
// the tests run all of it.

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, accessSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { get } from 'node:https'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

export const BUNDLE_ID = 'io.github.choco5958.switchboard'
// The bundle in the release zip (productName), whatever the person named their copy.
const APP_NAME = 'Switchboard.app'
const DOWNLOAD_BASE = 'https://github.com/choco5958/switchboard/releases/download'
// GitHub answers a release download with a redirect to its file storage.
const HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
const MAX_REDIRECTS = 5
// A download that stalls this long is dropped; the next check starts it again.
const IDLE_MS = 60_000

export type ZipFile = { name: string; sha512: string; size: number }

// x.y.z only: a prerelease (0.4.0-beta.1) or anything else is never installed.
function parts(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  return match ? match.slice(1).map(Number) : null
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parts(candidate)
  const b = parts(current.replace(/-.*$/, ''))
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  // A prerelease comes before the release of its version.
  return current.includes('-')
}

// The zip for this Mac's chip among the files of latest-mac.yml (electron-updater's info.files).
// Only the exact name the release workflow gives it: the name becomes part of a URL and a path.
export function zipFor(files: readonly { url: string; sha512?: string; size?: number }[], version: string, arch: string): ZipFile | null {
  if (!parts(version) || (arch !== 'arm64' && arch !== 'x64')) return null
  const name = `Switchboard-${version}-mac-${arch}.zip`
  const file = files.find(one => one.url === name)
  if (!file || typeof file.sha512 !== 'string' || !file.sha512 || typeof file.size !== 'number' || !(file.size > 0)) return null
  return { name, sha512: file.sha512, size: file.size }
}

export function zipUrl(version: string, name: string): string {
  return `${DOWNLOAD_BASE}/v${version}/${encodeURIComponent(name)}`
}

// Where a download, or a redirect of one, may go.
export function allowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && HOSTS.has(parsed.hostname) && !parsed.username && !parsed.password && (parsed.port === '' || parsed.port === '443')
  } catch {
    return false
  }
}

// The .app bundle the running executable sits in (app.getPath('exe')), or null when it is not
// one (a run from the repo).
export function bundleOf(exe: string): string | null {
  const macos = dirname(exe)
  const contents = dirname(macos)
  const bundle = dirname(contents)
  return basename(macos) === 'MacOS' && basename(contents) === 'Contents' && bundle.endsWith('.app') ? bundle : null
}

// Whether the swap can move this bundle: it and its folder are writable by this user. Not so in
// /Applications on a Mac that keeps it for administrators, in the disk image, or when macOS runs
// the app from a temporary read-only path (App Translocation); there the person updates by hand.
export function canReplace(bundle: string): boolean {
  try {
    accessSync(bundle, constants.W_OK)
    accessSync(dirname(bundle), constants.W_OK)
    return true
  } catch {
    return false
  }
}

function fetchTo(url: string, dest: string, size: number, hops = 0): Promise<void> {
  if (!allowedUrl(url)) return Promise.reject(new Error(`refused download from ${url}`))
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: { 'user-agent': 'Switchboard' } }, response => {
      const status = response.statusCode ?? 0
      const location = response.headers.location
      if (status >= 300 && status < 400 && location) {
        response.resume()
        if (hops >= MAX_REDIRECTS) return reject(new Error('too many redirects'))
        return void fetchTo(new URL(location, url).href, dest, size, hops + 1).then(resolve, reject)
      }
      if (status !== 200) {
        response.resume()
        return reject(new Error(`download answered ${status}`))
      }
      // More than latest-mac.yml says is not the file it describes; no reason to keep reading.
      let got = 0
      response.on('data', (chunk: Buffer) => {
        got += chunk.length
        if (got > size) request.destroy(new Error('download is larger than expected'))
      })
      pipeline(response, createWriteStream(dest, { mode: 0o600 })).then(resolve, reject)
    })
    request.setTimeout(IDLE_MS, () => request.destroy(new Error('download stalled')))
    request.on('error', reject)
  })
}

// Whether the file is the one latest-mac.yml describes: its size and its sha512 (base64).
export async function fileMatches(path: string, size: number, sha512: string): Promise<boolean> {
  if (statSync(path).size !== size) return false
  const hash = createHash('sha512')
  await pipeline(createReadStream(path), hash)
  return hash.digest('base64') === sha512
}

// Downloads the zip and keeps it only when it matches.
export async function download(url: string, dest: string, file: ZipFile): Promise<void> {
  rmSync(dest, { force: true })
  try {
    await fetchTo(url, dest, file.size)
    if (!(await fileMatches(dest, file.size, file.sha512))) throw new Error('the download does not match latest-mac.yml')
  } catch (error) {
    rmSync(dest, { force: true })
    throw error
  }
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 120_000 }, (error, stdout, stderr) => (error ? reject(new Error(`${basename(file)}: ${String(stderr).trim() || error.message}`)) : resolve(String(stdout)))),
  )
}

// Unpacks the zip into `dir` (ditto keeps the bundle's symlinks and permissions) and checks that
// it holds this app at the expected version with an intact signature. Returns the new bundle.
export async function unpack(zip: string, dir: string, version: string): Promise<string> {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  await run('/usr/bin/ditto', ['-x', '-k', zip, dir])
  const fresh = join(dir, APP_NAME)
  const plist = join(fresh, 'Contents', 'Info.plist')
  const id = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])).trim()
  const shown = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])).trim()
  if (id !== BUNDLE_ID || shown !== version) throw new Error(`the zip holds ${id} ${shown}, not ${BUNDLE_ID} ${version}`)
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', fresh])
  return fresh
}

// Run by /bin/sh after the app has quit. Everything comes in as arguments, never as script text.
// The old bundle goes aside first and comes back if the new one cannot take its place; a swap
// that fails leaves <stage>.failed, so the app offers that version as a download instead.
export const SWAP_SCRIPT = `#!/bin/sh
# Installs a Switchboard update once the app has quit (src/main/macUpdate.ts).
# $1 the app's pid, $2 the bundle to replace, $3 the new bundle, $4 the staging folder,
# $5 1 to open the app afterwards, $6 the log file.
PATH=/usr/bin:/bin:/usr/sbin:/sbin
pid=$1 target=$2 fresh=$3 stage=$4 relaunch=$5 log=$6
exec >>"$log" 2>&1
echo "$(date) installing $fresh to $target"
# The app is gone within seconds of quitting; one still there after two minutes did not quit.
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 1200 ]; then echo "the app did not quit"; exit 1; fi
  sleep 0.1
done
old=$stage/old.app
reopen() {
  if [ "$relaunch" = 1 ]; then open "$target"; fi
}
failed() {
  echo "$1" > "$stage.failed"
  echo "$1"
}
rm -rf "$old"
if ! mv "$target" "$old"; then
  failed "could not move the app aside; nothing changed"
  rm -rf "$stage"
  reopen
  exit 1
fi
if [ -e "$target" ] || ! mv "$fresh" "$target"; then
  rm -rf "$target"
  if mv "$old" "$target"; then
    failed "could not move the new version in; the old one is back"
    rm -rf "$stage"
    reopen
  else
    failed "could not put the old version back; it is at $old"
  fi
  exit 1
fi
xattr -dr com.apple.quarantine "$target" 2>/dev/null
echo "installed"
reopen
rm -rf "$stage"
exit 0
`

export type Swap = { pid: number; target: string; fresh: string; stage: string; relaunch: boolean; log: string }

// The arguments of the swap after the script's own path: positional, in the order it reads them.
export function swapArgs(swap: Swap): string[] {
  return [String(swap.pid), swap.target, swap.fresh, swap.stage, swap.relaunch ? '1' : '0', swap.log]
}

// Writes the script into the staging folder and starts it on its own, so it outlives the app.
export function startSwap(swap: Swap): void {
  const script = join(swap.stage, 'install.sh')
  writeFileSync(script, SWAP_SCRIPT, { mode: 0o700 })
  spawn('/bin/sh', [script, ...swapArgs(swap)], { detached: true, stdio: 'ignore' }).unref()
}

// Clears what an earlier run left in the updates folder: downloads and staged versions are made
// again when needed. Kept: a folder with old.app (a swap that could not put the app back) and the
// marks of versions that failed to install, newer than this one. Returns those versions.
export function cleanUpdates(dir: string, current: string): Set<string> {
  const failed = new Set<string>()
  if (!existsSync(dir)) return failed
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const mark = /^(.+)\.failed$/.exec(name)
    if (mark && isNewer(mark[1]!, current)) {
      failed.add(mark[1]!)
      continue
    }
    if (!mark && existsSync(join(path, 'old.app'))) continue
    rmSync(path, { recursive: true, force: true })
  }
  return failed
}
