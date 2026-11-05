// The Tauri app's own update, end to end, with nobody at the screen (docs/tauri-이전.md, step 8): the
// app finds a newer version, downloads it, and installs it when it quits, then starts again. The
// release comes from a local HTTPS server laid out as GitHub's and its update file is signed by a
// key made here (src/host/main.ts, CLAUDE_IDE_UPDATE_TEST); the app takes itself for 0.0.1, so the
// files pack-tauri made of this very build are the newer version. The download still has to match
// the signed update file's sha512, as a real one does.
//
//   node scripts/tauri-update-check.ts <app> <folder with the release files> [--expect-arch <x64|arm64>]
//
// <app>: Windows, the installed switchboard.exe (the installer replaces it in place); Linux, an
// AppImage (copied here first: the update replaces the copy); macOS, the .app (copied as well).
// --expect-arch: the architecture the installed executable has to have afterwards (Windows: an x64
// build on an ARM64 PC updates to the ARM64 one).
// The copy started again after the update runs with the system's own settings on macOS (`open`),
// so this runs on a machine for tests only (CI).

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:https'
import { basename, join, resolve } from 'node:path'
import { call, collectLines, stop, testHome, until } from './tauri-smoke.ts'

const PLATFORM = process.platform

// The app's data folder on Windows: AppData\Roaming follows USERPROFILE, which the check sets.
const windowsData = (home: string) => join(home, 'AppData', 'Roaming', 'claude-ide')
// The update log the app names as it hands the install over, else where it should be.
const updateLog = (lines: string[], home: string) => lines.map(line => /; log (.+)$/.exec(line)?.[1]).find(Boolean) ?? join(windowsData(home), 'update.log')

// A certificate for 127.0.0.1, which the app's Node trusts through NODE_EXTRA_CA_CERTS.
function certificate(dir: string): { key: string; cert: string } {
  const key = join(dir, 'tls.key')
  const cert = join(dir, 'tls.crt')
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' })
  if (made.status !== 0) throw new Error(`openssl: ${made.stderr || made.error}`)
  return { key, cert }
}

// The processes of the app at `app`, by system.
function appPids(app: string): number[] {
  if (PLATFORM === 'win32') {
    const listed = spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-Process switchboard -ErrorAction SilentlyContinue | ForEach-Object { '{0} {1}' -f $_.Id, $_.Path }"], { encoding: 'utf8' }).stdout
    return listed
      .split(/\r?\n/)
      .map(line => /^(\d+) (.+)$/.exec(line.trim()))
      .filter(match => match && match[2]!.toLowerCase() === app.toLowerCase())
      .map(match => Number(match![1]))
  }
  if (PLATFORM === 'linux') {
    // An AppImage's app: its process carries APPIMAGE, the file it came from.
    const pids: number[] = []
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        if (readFileSync(`/proc/${entry}/comm`, 'utf8').trim() !== 'switchboard') continue
        if (readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(`APPIMAGE=${app}`)) pids.push(Number(entry))
      } catch {
        // Gone, or not ours.
      }
    }
    return pids
  }
  const listed = spawnSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).stdout
  return listed
    .split('\n')
    .map(line => /^\s*(\d+) (.+)$/.exec(line))
    .filter(match => match && match[2]!.startsWith(`${app}/Contents/MacOS/`))
    .map(match => Number(match![1]))
}

// Folders of that name under `root`, at most `depth` levels down.
function findDirs(root: string, name: string, depth: number): string[] {
  const found: string[] = []
  const walk = (dir: string, left: number) => {
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (entry.name === name) found.push(path)
      else if (left > 0) walk(path, left - 1)
    }
  }
  walk(root, depth)
  return found
}

// The machine type in a Windows executable's PE header.
function peArch(file: string): string {
  const data = readFileSync(file)
  const machine = data.readUInt16LE(data.readUInt32LE(0x3c) + 4)
  return machine === 0xaa64 ? 'arm64' : machine === 0x8664 ? 'x64' : `0x${machine.toString(16)}`
}

// What tells that the update went in: a file replaced, for the systems that replace one.
function marker(app: string): string {
  return PLATFORM === 'darwin' ? join(app, 'Contents', 'Info.plist') : app
}

function kill(pid: number): void {
  if (PLATFORM === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    try {
      process.kill(pid)
    } catch {
      // Gone already.
    }
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const expectIndex = args.indexOf('--expect-arch')
  const expectArch = expectIndex >= 0 ? args.splice(expectIndex, 2)[1] : undefined
  const [given, releaseDir] = args
  if (!given || !releaseDir) {
    console.error('usage: node scripts/tauri-update-check.ts <app> <release folder> [--expect-arch <x64|arm64>]')
    return 2
  }
  if (PLATFORM === 'darwin' && !process.env.CI) {
    console.error('macOS: the updated app starts again with the system\'s own home and data; run this on a machine for tests (CI=true)')
    return 2
  }
  const { work, home, env } = testHome('sb-update-')
  const tls = certificate(work)

  // The app this check updates.
  let app = resolve(given)
  let exe = app
  if (PLATFORM === 'linux') {
    app = join(work, 'apps', 'Switchboard.AppImage')
    mkdirSync(join(work, 'apps'))
    copyFileSync(resolve(given), app)
    chmodSync(app, 0o755)
    exe = app
  } else if (PLATFORM === 'darwin') {
    app = join(work, 'apps', 'Switchboard.app')
    mkdirSync(join(work, 'apps'))
    const copied = spawnSync('ditto', [resolve(given), app])
    if (copied.status !== 0) throw new Error('could not copy the app')
    exe = join(app, 'Contents', 'MacOS', 'switchboard')
  }

  // The release: the update file pack-tauri wrote, signed here, and the files it lists.
  // electron-updater's name for this system's update file (src/main/updateSignature.ts channelFile).
  const channel = PLATFORM === 'darwin' ? 'latest-mac.yml' : PLATFORM === 'linux' ? `latest-linux${process.arch === 'x64' ? '' : `-${process.arch}`}.yml` : 'latest.yml'
  const updateFile = readFileSync(join(releaseDir, channel))
  const version = /^version: (\d+\.\d+\.\d+)$/m.exec(updateFile.toString('utf8'))?.[1]
  if (!version) throw new Error(`${channel} names no version`)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signature = sign(null, updateFile, privateKey).toString('base64')
  const served: string[] = []
  const site = createServer({ key: readFileSync(tls.key), cert: readFileSync(tls.cert) }, (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'https://127.0.0.1').pathname)
    served.push(path)
    const latest = /^\/releases\/latest\/download\/([^/]+)$/.exec(path)
    const file = /^\/releases\/download\/v([^/]+)\/([^/]+)$/.exec(path)
    if (latest?.[1] === channel || (file?.[1] === version && file[2] === channel)) return void res.end(updateFile)
    if (file?.[1] === version && file[2] === `${channel}.sig`) return void res.end(signature)
    if (file?.[1] === version && existsSync(join(releaseDir, file[2]!)) && file[2] !== channel) {
      res.setHeader('content-length', statSync(join(releaseDir, file[2]!)).size)
      return void createReadStream(join(releaseDir, file[2]!)).pipe(res)
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r))
  const address = site.address()
  const origin = `https://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

  const lines: string[] = []
  let child: ChildProcess | undefined
  let failure = ''
  const before = statSync(marker(app)).ino
  let started: number[] = []
  try {
    child = spawn(exe, [], {
      env: {
        ...env,
        NODE_EXTRA_CA_CERTS: tls.cert,
        CLAUDE_IDE_UPDATE_TEST: JSON.stringify({ origin, key: String(publicKey.export({ type: 'spki', format: 'pem' })), version: '0.0.1' }),
        CLAUDE_IDE_CAPTURE_JS: pageScript(),
        ...(PLATFORM === 'linux' ? { APPIMAGE_EXTRACT_AND_RUN: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    collectLines(child, lines)
    const first = await until('the app', () => appPids(app).length > 0 && appPids(app), 60000)
    console.log(`the app runs: ${first.join(', ')}`)
    await until('the update', () => lines.find(line => /^capture: update (ready|failed)/.test(line)), 240000)
    const outcome = lines.find(line => /^capture: update (ready|failed)/.test(line))!
    if (outcome.includes('failed')) throw new Error(outcome)
    // The app quits for the install and starts again: another process of the same app.
    await until('the app to quit', () => first.every(pid => !appPids(app).includes(pid)), 60000)
    console.log('the app quit')
    started = await until('the updated app to start', () => appPids(app).filter(pid => !first.includes(pid)).length > 0 && appPids(app).filter(pid => !first.includes(pid)), 300000)
    console.log(`the updated app runs: ${started.join(', ')}`)
    const after = statSync(marker(app)).ino
    if (PLATFORM !== 'win32' && after === before) throw new Error(`${marker(app)} was not replaced`)
    if (PLATFORM === 'win32') {
      const log = updateLog(lines, home)
      if (!log.toLowerCase().startsWith(home.toLowerCase())) throw new Error(`the app kept its data outside the check's home: ${log}`)
      const text = existsSync(log) ? readFileSync(log, 'utf8') : ''
      console.log(text.trim())
      if (!/the installer ended with 0$/m.test(text)) throw new Error('the installer did not end well')
    }
    if (expectArch && PLATFORM === 'win32' && peArch(app) !== expectArch) throw new Error(`the installed app is ${peArch(app)}, not ${expectArch}`)
    if (expectArch) console.log(`the installed app is ${expectArch}`)
    const downloads = served.filter(path => !path.endsWith('.yml') && !path.endsWith('.sig'))
    console.log(`downloaded: ${downloads.map(path => basename(path)).join(', ')}`)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    const health = await call(env, home, 'GET', '/health').catch(() => null)
    const bridgePid = health ? (JSON.parse(health.text) as { pid?: number }).pid : undefined
    for (const pid of [...started, ...appPids(app)]) kill(pid)
    if (child) stop(child)
    if (bridgePid) kill(bridgePid)
    site.close()
  }
  if (failure) {
    console.log(`FAILED: ${failure}`)
    if (PLATFORM === 'win32') {
      const log = updateLog(lines, home)
      console.log(`--- ${log}:\n${existsSync(log) ? readFileSync(log, 'utf8') : '(none)'}`)
      const updates = join(windowsData(home), 'updates')
      console.log(`--- ${updates}: ${existsSync(updates) ? readdirSync(updates).join(', ') : '(none)'}`)
      // Wherever the app put its data instead.
      for (const root of [home, process.env.APPDATA, process.env.LOCALAPPDATA]) {
        for (const found of root ? findDirs(root, 'claude-ide', 4) : []) console.log(`--- found ${found}: ${readdirSync(found).join(', ')}`)
      }
      // What still runs of the install: PowerShell, the installer, the app.
      const running = spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(powershell|pwsh|switchboard|Switchboard)' } | ForEach-Object { '{0} (parent {1}) {2}' -f $_.ProcessId, $_.ParentProcessId, $_.ExecutablePath }"], { encoding: 'utf8' }).stdout
      console.log(`--- running:\n${running.trim()}`)
    }
    console.log('--- the app said:')
    for (const line of lines.slice(-60)) console.log(line)
    return 1
  }
  console.log('the update went in and the app started again')
  return 0
}

// In the app's page: wait for the update to be downloaded, then install it now (the app quits).
function pageScript(): string {
  return `(async () => {
  const report = text => window.__TAURI_INTERNALS__.invoke('capture_log', { text })
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const end = Date.now() + 230000
  let last = ''
  for (;;) {
    // window.ide may come after this script, and a call before the host is up may fail.
    const status = await Promise.resolve().then(() => window.ide.updateStatus()).catch(e => ({ state: 'unknown', error: String(e && e.message || e) }))
    if (status.state !== last) report('update state ' + (last = status.state))
    if (status.state === 'ready') break
    if (['refused', 'manual'].includes(status.state) || Date.now() > end) {
      report('update failed: ' + JSON.stringify(status))
      return
    }
    await sleep(500)
  }
  report('update ready')
  await window.ide.updateInstall()
})()`
}

process.exit(await main())
