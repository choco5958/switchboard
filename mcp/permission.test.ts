import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge, listen } from '../bridge/server.ts'
import { askServer, runHook } from './hook.ts'
import { ADAPTERS, PASS, hookSocket, sameTerminal } from './permission.ts'
import { bridgeCall, createSession, listenForHooks, type Reply } from './server.ts'

// Short: a socket path has a limit of about 104 bytes, and the hook socket sits under HOME.
const dir = mkdtempSync(process.platform === 'win32' ? join(tmpdir(), 'sbh-') : '/tmp/sbh-')
const socketPath = join(dir, 'bridge.sock')
const APP = 'a'.repeat(64)
const bridge = createBridge(join(dir, 'ide.db'), undefined, { appKey: APP })
await listen(bridge.server, socketPath)

after(() => {
  bridge.close()
  rmSync(dir, { recursive: true, force: true })
})

function app(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { 'content-type': 'application/json', 'x-switchboard-app': APP } }, res => {
      let text = ''
      res.on('data', chunk => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

const patch = (turn = 't1') => ({
  session_id: 's',
  turn_id: turn,
  cwd: '/w',
  hook_event_name: 'PermissionRequest',
  tool_name: 'apply_patch',
  tool_input: { command: '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch', description: 'Add a.txt' },
})

describe('Codex adapter', () => {
  const codex = ADAPTERS.codex!

  test('a file change goes away from the terminal, with the patch as its summary', () => {
    const ask = codex.ask(patch())!
    assert.equal(ask.tool, 'apply_patch')
    assert.match(ask.summary, /Add File: a\.txt/)
    assert.equal(ask.complete, true)
    assert.equal(ask.reason, 'Add a.txt')
    assert.equal(ask.requestKey, codex.ask(patch())!.requestKey)
    assert.notEqual(ask.requestKey, codex.ask(patch('t2'))!.requestKey)
  })

  test('a command (outside the sandbox) and other events stay in the terminal', () => {
    assert.equal(codex.ask({ ...patch(), tool_name: 'Bash', tool_input: { command: 'touch x' } }), null)
    assert.equal(codex.ask({ ...patch(), hook_event_name: 'PreToolUse' }), null)
  })

  test('the reply is Codex hookSpecificOutput; no decision prints nothing', () => {
    assert.deepEqual(JSON.parse(codex.reply({ answer: 'allow', message: 'ok' })), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    assert.deepEqual(JSON.parse(codex.reply({ answer: 'deny', message: 'no' })).hookSpecificOutput.decision, { behavior: 'deny', message: 'no' })
    assert.equal(codex.reply(PASS), '')
  })
})

describe('the hook socket', () => {
  test('its name hides the key; only the same key matches', () => {
    const path = hookSocket('/h', 'r-secret', 'darwin')
    assert.match(path, /^\/h\/\.claude-ide\/agents\/h-[0-9a-f]{16}\.sock$/)
    assert.ok(!path.includes('secret'))
    assert.match(hookSocket('C:\\h', 'r-secret', 'win32'), /^\\\\\.\\pipe\\switchboard-hook-[0-9a-f]{16}$/)
    assert.ok(sameTerminal('r-1', 'r-1'))
    assert.ok(!sameTerminal('r-1', 'r-2'))
    assert.ok(!sameTerminal('', ''))
  })

  test('a hook with another key gets no decision, and no server prints nothing', async () => {
    const path = join(dir, 'other.sock')
    const listener = listenForHooks(path, 'r-right', async () => ({ answer: 'allow', message: '' }))
    await new Promise(resolve => listener.once('listening', resolve))
    assert.deepEqual(await askServer(path, 'r-wrong', ADAPTERS.codex!.ask(patch())!), PASS)
    assert.deepEqual(await askServer(path, 'r-right', ADAPTERS.codex!.ask(patch())!), { answer: 'allow', message: '' })
    listener.close()
    assert.deepEqual(await askServer(join(dir, 'none.sock'), 'r-right', ADAPTERS.codex!.ask(patch())!), PASS)
    assert.equal(await runHook('codex', JSON.stringify(patch()), { HOME: dir }), '')
  })
})

describe('the relay through the bridge', () => {
  test('away: the ask waits in the bridge, and the person allows or denies it', async () => {
    const terminal = 'r-relay'
    const session = createSession(
      { agent: 'codex', terminal, cwd: '/w', socket: socketPath, home: dir, cli: '' },
      { call: bridgeCall(socketPath), startBridge: async () => false, run: async () => ({ code: 1, stdout: '', stderr: '' }), log: () => undefined },
    )
    assert.ok(await session.ready())
    const listener = listenForHooks(hookSocket(dir, terminal), terminal, session.approve)
    await new Promise(resolve => listener.once('listening', resolve))
    const env = { HOME: dir, SWITCHBOARD_TERMINAL: terminal }

    const answer = async (decision: string, note = '') => {
      for (;;) {
        const pending = (await app('GET', '/state')).json.approvals?.find((a: any) => a.status === 'pending')
        if (pending) return app('POST', `/approvals/${pending.id}/answer`, { decision, note })
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }

    const allowed = runHook('codex', JSON.stringify(patch('a1')), env)
    await answer('allow')
    assert.equal(JSON.parse(await allowed).hookSpecificOutput.decision.behavior, 'allow')

    const denied = runHook('codex', JSON.stringify(patch('a2')), env)
    await answer('deny', 'not now')
    const decision = JSON.parse(await denied).hookSpecificOutput.decision
    assert.equal(decision.behavior, 'deny')
    assert.match(decision.message, /not now/)

    // 'terminal': the person answers in the terminal, and the hook decides nothing.
    const handed = runHook('codex', JSON.stringify(patch('a3')), env)
    await answer('terminal')
    assert.equal(await handed, '')
    listener.close()
    session.stop()
  })

  test('at the desk, or with a summary the person could not see in full, nothing is posted', async () => {
    const posted: string[] = []
    const deps = (away: boolean) => ({
      call: async (method: string, path: string): Promise<Reply> => {
        posted.push(`${method} ${path}`)
        if (path === '/presence') return { ok: true, status: 200, json: { away } }
        return { ok: true, status: 200, json: { token: 't' } }
      },
      startBridge: async () => false,
      run: async () => ({ code: 1, stdout: '', stderr: '' }),
      log: () => undefined,
    })
    const ask = ADAPTERS.codex!.ask(patch())!
    const options = { agent: 'codex', terminal: 'r-x', cwd: '/w', socket: '/none', home: dir, cli: '' }
    assert.deepEqual(await createSession(options, deps(false)).approve(ask, () => false), PASS)
    assert.deepEqual(await createSession(options, deps(true)).approve({ ...ask, complete: false }, () => false), PASS)
    assert.ok(!posted.includes('POST /approvals'))
  })
})
