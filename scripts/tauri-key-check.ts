// Linux: the Tauri app takes over the key the Electron app sealed (docs/tauri-이전.md, step 8;
// src-tauri/src/os.rs electron_key). The Electron app of a release runs first and seals its key
// with the secret service, as on a desktop; the Tauri app then starts and has to keep the very
// same key in its own keychain entry. Both run in a temporary home.
//
//   node scripts/tauri-key-check.ts <Electron AppImage> <Tauri AppImage>
//
// Run in a D-Bus session with an unlocked secret service and a display, for instance:
//   xvfb-run -a dbus-run-session -- sh -c 'printf pw | gnome-keyring-daemon --unlock --components=secrets >/dev/null; node scripts/tauri-key-check.ts ...'
// It reads the secret service of that session (secret-tool, libsecret-tools): never a desktop's own.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { call, collectLines, testHome, until } from './tauri-smoke.ts'

const SERVICE = 'io.github.choco5958.switchboard'

function secret(...attributes: string[]): string {
  return spawnSync('secret-tool', ['lookup', ...attributes], { encoding: 'utf8' }).stdout ?? ''
}

// Chromium's seal on Linux: "v11", AES-128-CBC under PBKDF2-SHA1("saltysalt", 1 round) of the password.
function openSealed(sealed: Buffer, password: string): string {
  if (sealed.subarray(0, 3).toString() !== 'v11') throw new Error(`app-key.bin starts with ${sealed.subarray(0, 3).toString()}, not v11`)
  const key = pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1')
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  return Buffer.concat([decipher.update(sealed.subarray(3)), decipher.final()]).toString('utf8')
}

function stopGroup(child: ChildProcess | undefined): void {
  if (!child?.pid || child.exitCode !== null) return
  try {
    process.kill(-child.pid)
  } catch {
    // Gone already.
  }
}

async function bridgePid(env: Record<string, string | undefined>, home: string): Promise<number | undefined> {
  const health = await call(env, home, 'GET', '/health').catch(() => null)
  return health?.status === 200 ? (JSON.parse(health.text) as { pid?: number }).pid : undefined
}

async function main(): Promise<number> {
  const [electronApp, tauriApp] = process.argv.slice(2)
  if (!electronApp || !tauriApp || process.platform !== 'linux') {
    console.error('usage (Linux): node scripts/tauri-key-check.ts <Electron AppImage> <Tauri AppImage>')
    return 2
  }
  const { home, env } = testHome('sb-key-')
  const run = { ...env, APPIMAGE_EXTRACT_AND_RUN: '1' }
  const keyFile = join(home, '.config', 'claude-ide', 'app-key.bin')
  const lines: string[] = []
  let electron: ChildProcess | undefined
  let tauri: ChildProcess | undefined
  const bridges = new Set<number>()
  let failure = ''
  try {
    // The Electron app, with the secret service as its password store.
    electron = spawn(resolve(electronApp), ['--no-sandbox', '--password-store=gnome-libsecret'], { env: run, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    collectLines(electron, lines)
    await until('the Electron app to seal its key', () => existsSync(keyFile), 90000)
    const first = await until('the Electron app\'s bridge', () => bridgePid(env, home), 60000)
    bridges.add(first)
    const password = secret('application', 'claude-ide')
    if (!password) {
      const all = spawnSync('secret-tool', ['search', '--all', 'xdg:schema', 'chrome_libsecret_os_crypt_password_v2'], { encoding: 'utf8' })
      throw new Error(`no secret for the application claude-ide; the secret service holds:\n${all.stdout}${all.stderr}`)
    }
    const electronKey = openSealed(readFileSync(keyFile), password)
    if (!/^[0-9a-f]{64}$/.test(electronKey)) throw new Error('the Electron app\'s key is not one')
    console.log(`the Electron app sealed its key (v11) and runs bridge ${first}`)
    stopGroup(electron)
    await new Promise(r => setTimeout(r, 3000))

    // The Tauri app, as a person starts it: it has no key of its own yet.
    if (secret('service', SERVICE, 'username', 'app-key')) throw new Error('the Tauri app has a key already')
    tauri = spawn(resolve(tauriApp), [], { env: run, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    collectLines(tauri, lines)
    const tauriKey = await until('the Tauri app to keep its key', () => secret('service', SERVICE, 'username', 'app-key').trim() || undefined, 90000)
    if (tauriKey !== electronKey) throw new Error('the Tauri app keeps a key of its own, not the Electron app\'s')
    console.log('the Tauri app keeps the Electron app\'s key')
    // With that key it talks to a bridge: the one left running, or the one it started for its build.
    const now = await until('a bridge for the Tauri app', () => bridgePid(env, home), 60000)
    bridges.add(now)
    console.log(now === first ? `it uses the Electron app's bridge ${first}` : `it replaced bridge ${first} with ${now} (another build)`)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    stopGroup(tauri)
    stopGroup(electron)
    const last = await bridgePid(env, home)
    if (last) bridges.add(last)
    for (const pid of bridges) {
      try {
        process.kill(pid)
      } catch {
        // Gone with the app.
      }
    }
  }
  if (failure) {
    console.log(`FAILED: ${failure}`)
    console.log('--- the apps said:')
    for (const line of lines.slice(-60)) console.log(line)
    return 1
  }
  return 0
}

process.exit(await main())
