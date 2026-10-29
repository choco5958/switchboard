import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge, listenTcp, newToken } from './server.ts'
import { curlConfigFile, endpointFile, requestTarget, resolveEndpoint, startCommand, usesTcp, type Endpoint } from './endpoint.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
const tempHome = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-ep-'))
  dirs.push(dir)
  return dir
}

function get(endpoint: Endpoint, path: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const target = requestTarget(endpoint)
  return new Promise((resolve, reject) => {
    const req = request({ ...target, path, headers: { ...target.headers, ...headers } }, res => {
      let text = ''
      res.on('data', chunk => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }))
    })
    req.on('error', reject)
    req.end()
  })
}

const run = (argv: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise(resolve =>
    execFile(argv[0]!, argv.slice(1), { env: { ...process.env, ...env } }, (error, stdout, stderr) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    ),
  )

test('a socket on macOS and Linux, TCP on Windows or when asked, a socket set by name always', () => {
  assert.equal(usesTcp({}, 'darwin'), false)
  assert.equal(usesTcp({}, 'win32'), true)
  assert.equal(usesTcp({ CLAUDE_IDE_TCP: '1' }, 'linux'), true)
  assert.equal(usesTcp({ CLAUDE_IDE_SOCKET: '/s', CLAUDE_IDE_TCP: '1' }, 'win32'), false)
  assert.deepEqual(resolveEndpoint({}, '/H', 'darwin'), { kind: 'socket', path: '/H/.claude-ide/bridge.sock' })
  const home = tempHome()
  assert.deepEqual(resolveEndpoint({}, home, 'win32'), { kind: 'tcp', port: 0, token: '' })
  mkdirSync(join(home, '.claude-ide'))
  writeFileSync(endpointFile(home), JSON.stringify({ port: 4567, token: 't' }))
  assert.deepEqual(resolveEndpoint({}, home, 'win32'), { kind: 'tcp', port: 4567, token: 't' })
  assert.deepEqual(requestTarget({ kind: 'tcp', port: 4567, token: 't' }), { host: '127.0.0.1', port: 4567, headers: { authorization: 'Bearer t' } })
})

test('start-bridge.json names the command; without it the old shell script', () => {
  const home = tempHome()
  assert.deepEqual(startCommand(home), { argv: ['sh', join(home, '.claude-ide', 'start-bridge.sh')], env: {} })
  mkdirSync(join(home, '.claude-ide'))
  writeFileSync(join(home, '.claude-ide', 'start-bridge.json'), JSON.stringify({ argv: ['/app/Switchboard', '/r/bridge/start.ts'], env: { ELECTRON_RUN_AS_NODE: '1' } }))
  assert.deepEqual(startCommand(home), { argv: ['/app/Switchboard', '/r/bridge/start.ts'], env: { ELECTRON_RUN_AS_NODE: '1' } })
})

test('over TCP only the token opens the bridge, never a web page, and a second bridge refuses', async () => {
  const home = tempHome()
  const token = newToken()
  const bridge = createBridge(join(home, 'ide.db'), 'ko-KR', { token })
  try {
    const port = await listenTcp(bridge.server, token, home)
    const endpoint = resolveEndpoint({ CLAUDE_IDE_TCP: '1' }, home)
    assert.deepEqual(endpoint, { kind: 'tcp', port, token })
    // Windows keeps the profile folder private by its own rules, not mode bits.
    if (process.platform !== 'win32') assert.equal(statSync(endpointFile(home)).mode & 0o777, 0o600)
    assert.equal(readFileSync(curlConfigFile(home), 'utf8'), `header = "Authorization: Bearer ${token}"\n`)
    assert.equal((await get(endpoint, '/health')).status, 200)
    assert.equal((await get({ kind: 'tcp', port, token: 'wrong' }, '/health')).status, 401)
    assert.equal((await get(endpoint, '/state', { origin: 'http://evil.example' })).status, 403)
    // The lock names a live process (this test's parent): another bridge is serving.
    writeFileSync(join(home, '.claude-ide', 'bridge.lock'), String(process.ppid))
    const second = createBridge(join(home, 'ide2.db'), 'ko-KR', { token: newToken() })
    await assert.rejects(listenTcp(second.server, 'x', home), /이미 돌고 있습니다/)
    second.close()
  } finally {
    bridge.close()
  }
})

test('start.ts brings a bridge up over TCP, and the shell command and the MCP server reach it', async () => {
  const home = tempHome()
  const env = { HOME: home, USERPROFILE: home, CLAUDE_IDE_TCP: '1', CLAUDE_IDE_DB: join(home, 'ide.db') }
  const start = join(import.meta.dirname, 'start.ts')
  assert.equal((await run([process.execPath, start], env)).code, 0)
  const saved = JSON.parse(readFileSync(endpointFile(home), 'utf8')) as { port: number; pid: number }
  try {
    // A second start finds it answering and leaves it be.
    assert.equal((await run([process.execPath, start], env)).code, 0)
    assert.equal((JSON.parse(readFileSync(endpointFile(home), 'utf8')) as { pid: number }).pid, saved.pid)
    const cli = await run([process.execPath, join(import.meta.dirname, '..', 'scripts', 'switchboard.ts'), 'sessions'], env)
    assert.deepEqual([cli.code, cli.stdout.trim()], [0, 'no sessions'])
    const mcp = await new Promise<string>(resolve => {
      const child = execFile(process.execPath, [join(import.meta.dirname, '..', 'mcp', 'server.ts'), '--agent', 'codex'], { env: { ...process.env, ...env } }, (_e, stdout) => resolve(stdout))
      child.stdin?.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_task', arguments: { title: 'TCP 작업' } } })}\n`)
    })
    assert.match(mcp, /"id":1/)
    const state = await get(resolveEndpoint({ CLAUDE_IDE_TCP: '1' }, home), '/state')
    assert.ok(state.json.tasks.some((task: { title: string }) => task.title === 'TCP 작업'))
  } finally {
    process.kill(saved.pid)
  }
})
