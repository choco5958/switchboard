// A check of a built Tauri app with nobody at the screen (docs/tauri-이전.md, step 8), the same on
// macOS, Windows and Linux: the app runs hidden (CLAUDE_IDE_CAPTURE_JS: no window, keychain,
// dialog or notification) on sample sessions, in a temporary home of its own, and a script in its
// page checks the bridge, the session list, a terminal and the in-app browser.
//
//   node scripts/tauri-smoke.ts <the app's executable> [--repo]
//
// --repo: a build that runs the repo's own files with the system's node (SWITCHBOARD_REPO); else
// the executable is an installed app's, with its own Node and Resources/node.
// Nothing outside the temporary folder is touched: HOME (and USERPROFILE, XDG_CONFIG_HOME), the
// bridge's socket and database, and Claude's config folder all point into it. Only the processes
// this script started are stopped: the app and the bridge it reports on /health. On Windows the
// app's data folder (AppData\Roaming\claude-ide) follows USERPROFILE into it as well.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { requestTarget, resolveEndpoint } from '../bridge/endpoint.ts'

const ROOT = resolve(import.meta.dirname, '..')
const WINDOWS = process.platform === 'win32'

export type Env = Record<string, string | undefined>

export function call(env: Env, home: string, method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const target = requestTarget(resolveEndpoint(env, home))
  return new Promise((done, fail) => {
    const sent = request({ ...target, method, path, headers: { ...target.headers, 'content-type': 'application/json' }, timeout: 5000 }, reply => {
      let text = ''
      reply.on('data', chunk => (text += chunk))
      reply.on('end', () => done({ status: reply.statusCode ?? 0, text }))
    })
    sent.on('error', fail)
    sent.on('timeout', () => sent.destroy(new Error('timed out')))
    sent.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

export async function until<T>(what: string, check: () => Promise<T | undefined | false> | T | undefined | false, ms: number): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await Promise.resolve()
      .then(check)
      .catch(() => undefined)
    if (value) return value
    if (Date.now() > end) throw new Error(`${what}: timed out`)
    await new Promise(r => setTimeout(r, 200))
  }
}

// Sample sessions, a task and two questions, written by a bridge of the repo's own and kept in the
// database the app's bridge then opens.
export async function seed(env: Env, home: string, scratch: string): Promise<void> {
  const bridge = spawn(process.execPath, [join(ROOT, 'bridge', 'server.ts')], { cwd: ROOT, env, stdio: 'ignore' })
  try {
    await until('the seeding bridge', async () => (await call(env, home, 'GET', '/health')).status === 200, 20000)
    const post = async (path: string, body: unknown) => {
      const { status, text } = await call(env, home, 'POST', path, body)
      if (status >= 400) throw new Error(`POST ${path}: ${status} ${text}`)
    }
    for (const [id, cwd] of [['s-web', '/work/checkout-web'], ['s-api', '/work/payments-api'], ['s-app', '/work/mobile-app'], ['s-docs', '/side/docs-site'], ['s-blog', '/side/blog']]) {
      await post('/sessions', { id, cwd })
    }
    await post('/tasks', { sessionId: 's-web', title: 'Checkout page redesign', now: 'Making the card form accessible', stage: '작업' })
    await post('/questions', { sessionId: 's-web', taskTitle: 'Checkout page redesign', question: 'One card number field, or four?', options: [{ key: 'a', label: 'One field' }, { key: 'b', label: 'Four fields' }], recommend: 'a' })
    await post('/questions', { sessionId: 's-api', question: 'How long do we keep idempotency keys?', options: [{ key: 'a', label: '24 hours' }, { key: 'b', label: '7 days' }] })
  } finally {
    bridge.kill()
    await new Promise(r => bridge.once('exit', r))
  }
  const db = new DatabaseSync(env.CLAUDE_IDE_DB!)
  const set = db.prepare('insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value')
  set.run('projects', JSON.stringify([{ name: 'scratch', cwd: scratch }, ...['/work/checkout-web', '/work/payments-api', '/work/mobile-app', '/side/docs-site'].map(cwd => ({ name: cwd.split('/').pop(), cwd }))]))
  set.run('lang', JSON.stringify('en'))
  db.close()
}

// What runs in the app's page once it has loaded. Each step reports one line; "done" ends it.
function pageScript(scratch: string, page: string): string {
  return `(async () => {
  const report = text => window.__TAURI_INTERNALS__.invoke('capture_log', { text })
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args)
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms
    for (;;) {
      const value = await Promise.resolve().then(fn).catch(() => undefined)
      if (value) return value
      if (Date.now() > end) throw new Error('timed out')
      await sleep(250)
    }
  }
  const step = async (name, fn) => {
    try { report('step ' + name + ': ' + (await fn())) } catch (e) { report('step ' + name + ': FAILED ' + (e && e.message || e)) }
  }
  await step('bridge', () => until(() => window.ide.connected()).then(() => 'connected'))
  await step('rows', () => until(() => document.querySelectorAll('.session-row').length >= 2 && document.querySelectorAll('.session-row').length + ' rows').catch(e => { throw new Error(document.querySelectorAll('.session-row').length + ' rows; ' + document.body.innerText.slice(0, 300).replace(/\s+/g, ' ')) }))
  await step('questions', async () => {
    const state = await window.ide.state()
    const open = (state.questions || []).filter(q => q.status === 'pending').length
    if (open < 2) throw new Error(open + ' open questions')
    return open + ' open questions'
  })
  await step('terminal', async () => {
    const term = await window.ide.termOpen(${JSON.stringify(scratch)}, false, 100, 30)
    if (term.error) throw new Error(term.error)
    await sleep(1500)
    window.ide.termWrite(term.id, ${JSON.stringify(WINDOWS ? 'echo "smoke-$(40+2)"\r' : 'echo smoke-$((40+2))\r')})
    await until(async () => (await window.ide.termBuffer(term.id)).data.includes('smoke-42'))
    await window.ide.termClose(term.id)
    return 'echoed'
  })
  await step('browser', async () => {
    await invoke('browser_place', { url: ${JSON.stringify(page)}, x: 0, y: 0, width: 800, height: 600, visible: true })
    const title = await until(() => invoke('browser_run', { code: 'document.readyState === "complete" && document.title' }))
    // The app's own world keeps what it sets between scripts, and the page does not see it.
    await invoke('browser_run', { code: 'window.__smoke = 7; 1' })
    const kept = await invoke('browser_run', { code: 'window.__smoke' })
    const promised = await invoke('browser_run', { code: 'new Promise(r => setTimeout(() => r({ text: document.getElementById("t").textContent }), 50))' })
    const shot = await invoke('browser_capture', { rect: [0, 0, 200, 100] })
    if (title !== 'Smoke page' || kept !== 7 || !promised || promised.text !== 'hello' || !shot || !shot.startsWith('data:image/png;base64,')) {
      throw new Error(JSON.stringify({ title, kept, promised, shot: shot && shot.slice(0, 40) }))
    }
    return 'title, world, promise and a ' + shot.length + '-character snapshot'
  })
  report('done')
})()`
}

export function stop(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  if (WINDOWS) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill()
}

// A temporary home for a run of the app: nothing it writes goes outside. On Windows AppData\Roaming
// is %USERPROFILE%\AppData\Roaming only once that folder exists: without it the app found no data
// folder and kept its data beside itself, in the folder an update's installer replaces.
export function testHome(prefix: string): { work: string; home: string; scratch: string; env: Env } {
  const work = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const home = join(work, 'home')
  const scratch = join(work, 'scratch')
  for (const dir of [home, scratch, join(work, 'claude')]) mkdirSync(dir, { recursive: true })
  if (WINDOWS) for (const dir of ['Roaming', 'Local']) mkdirSync(join(home, 'AppData', dir), { recursive: true })
  const env: Env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    CLAUDE_CONFIG_DIR: join(work, 'claude'),
    CLAUDE_IDE_DB: join(work, 'bridge.db'),
    ...(WINDOWS ? {} : { CLAUDE_IDE_SOCKET: join(work, 'b.sock'), SHELL: process.env.SHELL || '/bin/sh' }),
  }
  return { work, home, scratch, env }
}

// Every line the app prints, kept, and the ones that tell how it goes shown.
export function collectLines(app: ChildProcess, lines: string[]): void {
  for (const stream of [app.stdout!, app.stderr!]) {
    let rest = ''
    stream.on('data', chunk => {
      const parts = (rest + chunk).split(/\r?\n/)
      rest = parts.pop() ?? ''
      for (const line of parts) {
        lines.push(line)
        if (/^capture: |panicked|error|update/i.test(line)) console.log(line)
      }
    })
  }
}

async function main(): Promise<number> {
  const [exe, flag] = process.argv.slice(2)
  if (!exe) {
    console.error('usage: node scripts/tauri-smoke.ts <app executable> [--repo]')
    return 2
  }
  const { work, home, scratch, env } = testHome('sb-smoke-')
  const site = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end('<!doctype html><title>Smoke page</title><h1 id="t">hello</h1><script>console.log("smoke console")</script>')
  })
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r))
  const address = site.address()
  const page = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`
  const lines: string[] = []
  let app: ChildProcess | undefined
  try {
    await seed(env, home, scratch)
    app = spawn(resolve(exe), [], {
      env: { ...env, CLAUDE_IDE_CAPTURE_JS: pageScript(scratch, page), ...(flag === '--repo' ? { SWITCHBOARD_REPO: ROOT } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    collectLines(app, lines)
    const ended = new Promise(r => app!.once('exit', code => r(`the app ended (${code})`)))
    const outcome = await Promise.race([until('the page script', () => lines.includes('capture: done'), 240000).then(() => 'done'), ended])
    if (outcome !== 'done') console.log(outcome)
  } catch (error) {
    console.log(error instanceof Error ? error.message : error)
  } finally {
    const health = await call(env, home, 'GET', '/health').catch(() => null)
    const bridgePid = health ? (JSON.parse(health.text) as { pid?: number }).pid : undefined
    if (app) stop(app)
    await new Promise(r => setTimeout(r, 1500))
    if (bridgePid) {
      try {
        process.kill(bridgePid)
      } catch {
        // Gone with the app.
      }
    }
    site.close()
    await new Promise(r => setTimeout(r, 500))
    try {
      rmSync(work, { recursive: true, force: true })
    } catch {
      // A file still held open (Windows): the system's temporary folder keeps it.
    }
  }
  const steps = lines.filter(line => line.startsWith('capture: step '))
  const failed = steps.filter(line => line.includes(': FAILED'))
  const finished = lines.includes('capture: done')
  console.log(`${steps.length} steps, ${failed.length} failed${finished ? '' : ', the script did not finish'}`)
  if (!finished || failed.length > 0 || steps.length === 0) {
    console.log('--- the app said:')
    for (const line of lines.slice(-60)) console.log(line)
    return 1
  }
  return 0
}

if (import.meta.main) process.exit(await main())
