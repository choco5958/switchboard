// Temporary: the app's hand-over of an update install (src/main/installUpdate.ts) on Windows, from a
// process that quits at once as the app's host does. Stand-ins: whoami.exe as installer and app.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const d = mkdtempSync(join(tmpdir(), 'probe-'))
const whoami = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe')
copyFileSync(whoami, join(d, 'installer.exe'))
copyFileSync(whoami, join(d, 'app.exe'))
const module = new URL('../../src/main/installUpdate.ts', import.meta.url).href
const input = { installer: join(d, 'installer.exe'), relaunch: true, app: join(d, 'app.exe'), log: join(d, 'update.log'), failedMark: join(d, 'failed'), node: process.execPath }
const hand = spawnSync(process.execPath, ['--input-type=module', '-e', `const { startWindowsInstall } = await import(${JSON.stringify(module)}); startWindowsInstall({ ...${JSON.stringify(input)}, pid: process.pid }); setTimeout(() => process.exit(0), 500)`], { encoding: 'utf8', timeout: 30000 })
console.log(`the hand-over process ended with ${hand.status} ${hand.stderr.trim()}`)
let text = ''
for (let i = 0; i < 30 && !/starting the app/.test(text); i++) {
  await new Promise(r => setTimeout(r, 1000))
  text = existsSync(input.log) ? readFileSync(input.log, 'utf8') : ''
}
console.log(text.trim())
console.log(`installer left: ${existsSync(input.installer)}, failed mark: ${existsSync(input.failedMark) ? readFileSync(input.failedMark, 'utf8') : 'none'}`)
process.exit(/starting the app/.test(text) && !existsSync(input.installer) ? 0 : 1)
