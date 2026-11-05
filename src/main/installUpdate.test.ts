import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { appImageTarget, installerName, replaceAppImage, startWindowsInstall } from './installUpdate'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the release file for each system, under the names the release gives them', () => {
  expect(installerName('0.4.0', 'win32', 'x64')).toBe('Switchboard-0.4.0-win-x64.exe')
  expect(installerName('0.4.0', 'win32', 'arm64')).toBe('Switchboard-0.4.0-win-arm64.exe')
  expect(installerName('0.4.0', 'linux', 'x64')).toBe('Switchboard-0.4.0-linux-x86_64.AppImage')
  expect(installerName('0.4.0', 'linux', 'arm64')).toBe('Switchboard-0.4.0-linux-arm64.AppImage')
  expect(installerName('0.4.0', 'linux', 'ia32')).toBeNull()
  expect(installerName('0.4.0', 'darwin', 'arm64')).toBeNull()
})

test('an AppImage updates in place only where its folder can be written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-appimage-'))
  dirs.push(dir)
  const file = join(dir, 'Switchboard.AppImage')
  writeFileSync(file, 'old')
  expect(appImageTarget({ APPIMAGE: file })).toBe(file)
  expect(appImageTarget({})).toBeNull()
  if (process.getuid?.() !== 0) {
    chmodSync(dir, 0o555)
    expect(appImageTarget({ APPIMAGE: file })).toBeNull()
  }
})

test('the new AppImage takes the place of the running one, runnable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-appimage-'))
  dirs.push(dir)
  const target = join(dir, 'Switchboard.AppImage')
  const fresh = join(dir, '.switchboard-update.AppImage')
  writeFileSync(target, 'old', { mode: 0o755 })
  writeFileSync(fresh, 'new', { mode: 0o600 })
  replaceAppImage({ pid: process.pid, target, fresh, relaunch: false })
  expect(readFileSync(target, 'utf8')).toBe('new')
  expect(statSync(target).mode & 0o111).not.toBe(0)
})

// The hand-over runs as it does on Windows, with shell scripts for the installer and the app.
async function windowsInstall(installerExit: number) {
  const dir = mkdtempSync(join(tmpdir(), 'sb-wininstall-'))
  dirs.push(dir)
  const installer = join(dir, 'Switchboard-0.4.0-win-x64.exe')
  const app = join(dir, 'switchboard.exe')
  writeFileSync(installer, `#!/bin/sh\n[ -e "${join(dir, 'app-gone')}" ] && echo "$@" > "${join(dir, 'installer-args')}"\nexit ${installerExit}\n`, { mode: 0o755 })
  writeFileSync(app, `#!/bin/sh\necho started > "${join(dir, 'started')}"\n`, { mode: 0o755 })
  // The app: still running when the install is handed over, gone a moment later.
  const running = spawn('/bin/sh', ['-c', `sleep 0.5; touch "${join(dir, 'app-gone')}"`])
  const log = join(dir, 'update.log')
  startWindowsInstall({ pid: running.pid!, installer, relaunch: true, app, log, failedMark: join(dir, '0.4.0.failed'), node: process.execPath })
  for (let i = 0; i < 100 && !existsSync(join(dir, 'started')); i++) await new Promise(r => setTimeout(r, 100))
  return { dir, installer, log: readFileSync(log, 'utf8') }
}

test('the Windows install waits for the app to end, runs the installer with /S, then starts the app', async () => {
  const { dir, installer, log } = await windowsInstall(0)
  expect(readFileSync(join(dir, 'installer-args'), 'utf8').trim()).toBe('/S')
  expect(existsSync(join(dir, 'started'))).toBe(true)
  expect(existsSync(installer)).toBe(false)
  expect(existsSync(join(dir, '0.4.0.failed'))).toBe(false)
  expect(log).toMatch(/the installer ended with 0\n.*starting the app\n$/)
})

test('a failed Windows install marks its version and starts the app there was', async () => {
  const { dir, log } = await windowsInstall(3)
  expect(readFileSync(join(dir, '0.4.0.failed'), 'utf8')).toBe('installer exit 3')
  expect(existsSync(join(dir, 'started'))).toBe(true)
  expect(log).toContain('the installer ended with 3')
})
