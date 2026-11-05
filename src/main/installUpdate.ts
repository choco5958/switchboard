// The Tauri app's own updates on Windows and in a Linux AppImage (docs/tauri-이전.md, step 8), as
// macUpdate.ts is for macOS. The release's file for this system is downloaded once its update file
// carries the release key's signature (updateSignature.ts) and matches that file's sha512; it
// goes in once the app has quit (updateFlow.ts stagedUpdates).
// - Windows: the installer (Switchboard-<v>-win-<arch>.exe), run with /S by the app's own Node once
//   the app has ended, which then starts the app again itself (the installer's /R starts it through
//   the desktop shell, which an elevated or shell-less session does not have). That Node, like the
//   bridge's and the terminal host's, is the copy beside the runtime (appRoot.ts nodeExecutable), so
//   nothing holds the installed files. Not PowerShell: started detached it has no console, and
//   Windows PowerShell then ends at once without running a line.
// - Linux: the AppImage (Switchboard-<v>-linux-<x86_64|arm64>.AppImage) takes the place of the file
//   the app runs from ($APPIMAGE), which a running AppImage allows. A .deb or any other package is
//   the system package manager's to update: that copy is told where to download it.

import { spawn } from 'node:child_process'
import { accessSync, appendFileSync, chmodSync, closeSync, constants, openSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

// The release file of `version` for this system, or null where this copy does not install one.
export function installerName(version: string, platform: string, arch: string): string | null {
  if (arch !== 'x64' && arch !== 'arm64') return null
  if (platform === 'win32') return `Switchboard-${version}-win-${arch}.exe`
  if (platform === 'linux') return `Switchboard-${version}-linux-${arch === 'x64' ? 'x86_64' : 'arm64'}.AppImage`
  return null
}

// Where an AppImage update goes: beside the AppImage, so it takes its place with one rename.
export function appImageTarget(env: Record<string, string | undefined>): string | null {
  const file = env.APPIMAGE
  if (!file) return null
  try {
    accessSync(dirname(file), constants.W_OK)
    return file
  } catch {
    return null
  }
}

// After the app has quit: the installer's run, as a script for the Node that outlives the app. Its
// argument: [pid, installer, app, relaunch, log, failedMark]. An installer that fails marks its
// version so the app offers a download instead (cleanUpdates); the app starts again either way, a
// failed install having left the version there was.
export const WINDOWS_INSTALL = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const [pid, installer, app, relaunch, log, failedMark] = JSON.parse(process.argv[1])
const say = text => fs.appendFileSync(log, new Date().toISOString() + ' ' + text + '\\n')
const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
;(async () => {
  for (const end = Date.now() + 120000; alive() && Date.now() < end; ) await pause(200)
  say('installing ' + installer)
  const code = await new Promise(resolve => {
    const run = spawn(installer, ['/S'], { stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => { say('the installer did not end in 10 minutes'); run.kill() }, 600000)
    run.on('spawn', () => say('the installer runs as process ' + run.pid))
    run.on('error', error => { clearTimeout(timer); say('the installer did not start: ' + error.message); resolve(-1) })
    run.on('exit', code => { clearTimeout(timer); resolve(code ?? -1) })
  })
  say('the installer ended with ' + code)
  if (code !== 0) fs.writeFileSync(failedMark, 'installer exit ' + code)
  fs.rmSync(installer, { force: true })
  if (relaunch) {
    say('starting the app')
    spawn(app, [], { detached: true, stdio: 'ignore' }).unref()
  }
})()
`

// `node`: the Node to run it, one outside the folder the installer replaces. `app`: the app's
// executable, started again once the installer has put the new version there.
type WindowsInstall = { pid: number; installer: string; relaunch: boolean; app: string; log: string; failedMark: string; node: string }

// The script's own lines and anything Node prints go to the update log.
export function startWindowsInstall(input: WindowsInstall): void {
  console.error(`update: ${input.installer} runs once process ${input.pid} has ended; log ${input.log}`)
  appendFileSync(input.log, `${new Date().toISOString()} the app quits; the installer runs after it (${input.installer})\n`)
  // Not the host's own settings (its key among them): the app started again makes its own.
  const { SWITCHBOARD_HOST: _host, ...env } = process.env
  const out = openSync(input.log, 'a')
  try {
    const argument = JSON.stringify([input.pid, input.installer, input.app, input.relaunch, input.log, input.failedMark])
    const child = spawn(input.node, ['-e', WINDOWS_INSTALL, argument], { detached: true, stdio: ['ignore', out, out], windowsHide: true, env })
    child.on('error', error => appendFileSync(input.log, `${new Date().toISOString()} the install did not start: ${error.message}\n`))
    child.unref()
  } finally {
    closeSync(out)
  }
}

// The AppImage downloaded beside the running one takes its place; the running app keeps the file
// it opened. Started again once this one has gone (a second copy would only hand over to it).
export function replaceAppImage(input: { pid: number; target: string; fresh: string; relaunch: boolean }): void {
  chmodSync(input.fresh, 0o755)
  renameSync(input.fresh, input.target)
  if (!input.relaunch) return
  spawn('/bin/sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$2"', 'switchboard-relaunch', String(input.pid), input.target], { detached: true, stdio: 'ignore' }).unref()
}
