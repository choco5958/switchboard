// Temporary: does the update's PowerShell hand-over (src/main/installUpdate.ts) run on Windows?
// Each case: a process that hands the install over and quits at once, as the app's host does; a
// stand-in installer and app (whoami.exe copies). Prints the update log and what still runs.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = import.meta.filename
const [mode, dir] = process.argv.slice(2)

if (mode === 'hand') {
  const { startWindowsInstall } = await import('../../src/main/installUpdate.ts')
  const log = join(dir!, 'update.log')
  startWindowsInstall({ pid: process.pid, installer: join(dir!, 'installer.exe'), relaunch: true, app: join(dir!, 'app.exe'), log, failedMark: join(dir!, 'failed') })
  setTimeout(() => process.exit(0), 500)
} else {
  const cases: Record<string, (dir: string) => NodeJS.ProcessEnv> = {
    plain: () => ({ ...process.env }),
    'test home': d => {
      const home = join(d, 'home')
      for (const sub of ['Roaming', 'Local']) mkdirSync(join(home, 'AppData', sub), { recursive: true })
      return { ...process.env, HOME: home, USERPROFILE: home }
    },
  }
  let bad = 0
  for (const [name, envOf] of Object.entries(cases)) {
    const d = mkdtempSync(join(tmpdir(), 'probe-'))
    const whoami = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe')
    copyFileSync(whoami, join(d, 'installer.exe'))
    copyFileSync(whoami, join(d, 'app.exe'))
    const started = Date.now()
    const hand = spawnSync(process.execPath, [here, 'hand', d], { env: envOf(d), encoding: 'utf8', timeout: 30000 })
    console.log(`== ${name}: the hand-over process ended with ${hand.status} after ${Date.now() - started} ms ${hand.stderr.trim()}`)
    const log = join(d, 'update.log')
    let text = ''
    for (let i = 0; i < 60 && !/starting the app/.test(text); i++) {
      await new Promise(r => setTimeout(r, 1000))
      text = existsSync(log) ? readFileSync(log, 'utf8') : ''
    }
    console.log(text.trim() || '(empty log)')
    console.log(`installer left: ${existsSync(join(d, 'installer.exe'))}, failed mark: ${existsSync(join(d, 'failed'))}`)
    if (!/starting the app/.test(text)) bad++
    console.log(spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(powershell|installer|app)\\.exe$' } | ForEach-Object { '{0} (parent {1}) {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine.Substring(0, [Math]::Min(120, $_.CommandLine.Length)) }"], { encoding: 'utf8' }).stdout.trim())
  }
  process.exit(bad ? 1 : 0)
}
