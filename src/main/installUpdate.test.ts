import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { appImageTarget, installerName, replaceAppImage, windowsInstallScript } from './installUpdate'

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

test('the Windows install waits for the app, runs the installer quietly and keeps paths literal', () => {
  const script = windowsInstallScript({ pid: 4242, installer: "C:\\Users\\O'Brien\\updates\\Switchboard-0.4.0-win-x64.exe", relaunch: true, log: 'C:\\Users\\me\\update.log', failedMark: 'C:\\Users\\me\\updates\\0.4.0.failed' })
  const lines = script.split('\n')
  expect(lines[1]).toBe('Wait-Process -Id 4242 -Timeout 120')
  expect(script).toContain("Start-Process -FilePath 'C:\\Users\\O''Brien\\updates\\Switchboard-0.4.0-win-x64.exe' -ArgumentList @('/S', '/R') -PassThru")
  expect(script).toContain("Set-Content -LiteralPath 'C:\\Users\\me\\updates\\0.4.0.failed'")
  // Nothing of a path is read as PowerShell: no double-quoted strings that expand $ or `.
  expect(script).not.toMatch(/"[^"]*\\[^"]*"/)
  expect(windowsInstallScript({ pid: 1, installer: 'C:\\a.exe', relaunch: false, log: 'C:\\l', failedMark: 'C:\\f' })).toContain("-ArgumentList @('/S') -PassThru")
})
