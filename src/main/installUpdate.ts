// The Tauri app's own updates on Windows and in a Linux AppImage (docs/tauri-이전.md, step 8), as
// macUpdate.ts is for macOS. The release's file for this system is downloaded once its update file
// carries the release key's signature (updateSignature.ts) and matches that file's sha512; it
// goes in once the app has quit (updateFlow.ts stagedUpdates).
// - Windows: the installer (Switchboard-<v>-win-<arch>.exe), run with /S by a PowerShell that first
//   waits for the app to end; /R starts the app again. The bridge and the terminal host run on a
//   copy of the app's Node (runtime.ts copyNode), so nothing holds the installed files.
// - Linux: the AppImage (Switchboard-<v>-linux-<x86_64|arm64>.AppImage) takes the place of the file
//   the app runs from ($APPIMAGE), which a running AppImage allows. A .deb or any other package is
//   the system package manager's to update: that copy is told where to download it.

import { spawn } from 'node:child_process'
import { accessSync, chmodSync, constants, renameSync } from 'node:fs'
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

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`

// What PowerShell runs after the app has quit (-EncodedCommand: no quoting by a shell between).
// An installer that fails marks its version so the app offers a download instead (cleanUpdates).
export function windowsInstallScript(input: { pid: number; installer: string; relaunch: boolean; log: string; failedMark: string }): string {
  const args = input.relaunch ? "@('/S', '/R')" : "@('/S')"
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `Wait-Process -Id ${input.pid} -Timeout 120`,
    `Add-Content -LiteralPath ${psQuote(input.log)} -Value ((Get-Date -Format o) + ' installing ' + ${psQuote(input.installer)})`,
    `$run = Start-Process -FilePath ${psQuote(input.installer)} -ArgumentList ${args} -PassThru`,
    '$run.WaitForExit()',
    `Add-Content -LiteralPath ${psQuote(input.log)} -Value ((Get-Date -Format o) + ' the installer ended with ' + $run.ExitCode)`,
    `if ($run.ExitCode -ne 0) { Set-Content -LiteralPath ${psQuote(input.failedMark)} -Value ('installer exit ' + $run.ExitCode) }`,
    `Remove-Item -LiteralPath ${psQuote(input.installer)} -Force`,
  ].join('\n')
}

export function startWindowsInstall(input: { pid: number; installer: string; relaunch: boolean; log: string; failedMark: string }): void {
  const encoded = Buffer.from(windowsInstallScript(input), 'utf16le').toString('base64')
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

// The AppImage downloaded beside the running one takes its place; the running app keeps the file
// it opened. Started again once this one has gone (a second copy would only hand over to it).
export function replaceAppImage(input: { pid: number; target: string; fresh: string; relaunch: boolean }): void {
  chmodSync(input.fresh, 0o755)
  renameSync(input.fresh, input.target)
  if (!input.relaunch) return
  spawn('/bin/sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$2"', 'switchboard-relaunch', String(input.pid), input.target], { detached: true, stdio: 'ignore' }).unref()
}
