// Temporary: which way of starting PowerShell from a process that quits at once (as the app's host
// does at an update) lets it run on? Each case writes markers with .NET straight to a file, so its
// stdio does not matter; "stay" cases keep the starter alive to read PowerShell's exit code.
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = import.meta.filename
const [mode, which, dir] = process.argv.slice(2)
const ps = (marker: string) => [
  `[IO.File]::AppendAllText('${marker}', \"started\`n\")`,
  'Start-Sleep -Seconds 2',
  `[IO.File]::AppendAllText('${marker}', \"done\`n\")`,
].join('\n')

type Case = { options: (dir: string) => SpawnOptions; stay?: boolean; via?: 'cmd' }
const cases: Record<string, Case> = {
  'detached, stdio to a file': { options: d => { const out = openSync(join(d, 'out.log'), 'a'); return { detached: true, stdio: ['ignore', out, out], windowsHide: true } } },
  'detached, stdio to a file, stays': { options: d => { const out = openSync(join(d, 'out.log'), 'a'); return { detached: true, stdio: ['ignore', out, out], windowsHide: true } }, stay: true },
  'detached, no stdio': { options: () => ({ detached: true, stdio: 'ignore', windowsHide: true }) },
  'detached, no stdio, no hide': { options: () => ({ detached: true, stdio: 'ignore' }) },
  'not detached, no stdio, hidden': { options: () => ({ stdio: 'ignore', windowsHide: true }) },
  'cmd start, no stdio': { options: () => ({ detached: true, stdio: 'ignore', windowsHide: true }), via: 'cmd' },
}

if (mode === 'hand') {
  const one = cases[which!]!
  const marker = join(dir!, 'marker.log')
  const encoded = Buffer.from(ps(marker), 'utf16le').toString('base64')
  const args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded]
  const child = one.via === 'cmd'
    ? spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', 'powershell.exe', ...args], one.options(dir!))
    : spawn('powershell.exe', args, one.options(dir!))
  child.on('error', error => console.error(`error: ${error.message}`))
  if (one.stay) child.on('exit', (code, signal) => { console.error(`powershell ended: ${code} ${signal}`); process.exit(0) })
  else { child.unref(); setTimeout(() => process.exit(0), 500) }
} else {
  let line = ''
  for (const name of Object.keys(cases)) {
    const d = mkdtempSync(join(tmpdir(), 'probe-'))
    const hand = spawnSync(process.execPath, [here, 'hand', name, d], { encoding: 'utf8', timeout: 30000 })
    await new Promise(r => setTimeout(r, 5000))
    const marker = join(d, 'marker.log')
    const text = existsSync(marker) ? readFileSync(marker, 'utf8').trim().replace(/\n/g, ', ') : '(nothing)'
    const out = existsSync(join(d, 'out.log')) ? readFileSync(join(d, 'out.log'), 'utf8').trim() : ''
    line = `== ${name}: ${text} | starter: ${hand.status} ${hand.stderr.trim()}${out ? ` | output: ${out.slice(0, 300)}` : ''}`
    console.log(line)
  }
  // The app's own hand-over as it is now (src/main/installUpdate.ts).
  const d = mkdtempSync(join(tmpdir(), 'probe-'))
  const whoami = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe')
  copyFileSync(whoami, join(d, 'installer.exe'))
  copyFileSync(whoami, join(d, 'app.exe'))
  spawnSync(process.execPath, ['--input-type=module', '-e', `const { startWindowsInstall } = await import(${JSON.stringify(new URL('../../src/main/installUpdate.ts', import.meta.url).href)}); startWindowsInstall({ pid: process.pid, installer: ${JSON.stringify(join(d, 'installer.exe'))}, relaunch: true, app: ${JSON.stringify(join(d, 'app.exe'))}, log: ${JSON.stringify(join(d, 'update.log'))}, failedMark: ${JSON.stringify(join(d, 'failed'))} }); setTimeout(() => process.exit(0), 500)`], { encoding: 'utf8', timeout: 30000 })
  let text = ''
  for (let i = 0; i < 30 && !/starting the app/.test(text); i++) {
    await new Promise(r => setTimeout(r, 1000))
    text = existsSync(join(d, 'update.log')) ? readFileSync(join(d, 'update.log'), 'utf8') : ''
  }
  console.log(`== the app's hand-over:\n${text.trim()}\ninstaller left: ${existsSync(join(d, 'installer.exe'))}`)
  process.exit(/starting the app/.test(text) ? 0 : 1)
}
