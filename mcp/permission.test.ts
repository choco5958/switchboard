import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge, listen } from '../bridge/server.ts'
import { askServer, runHook } from './hook.ts'
import { ADAPTERS, PASS, hookSocket, opencodeAsk, sameTerminal } from './permission.ts'
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

describe('Qwen adapter', () => {
  const qwen = ADAPTERS.qwen!
  const base = { hook_event_name: 'PermissionRequest', session_id: 's1', prompt_id: 'p1', cwd: '/w' }

  test('a command, a new file and an edit go away with what they do as the summary', () => {
    const run = qwen.ask({ ...base, tool_name: 'run_shell_command', tool_input: { command: 'npm test', description: 'Run the  tests' } })!
    assert.deepEqual([run.tool, run.summary, run.complete, run.cwd], ['run_shell_command', 'npm test\n# Run the tests', true, '/w'])
    assert.match(run.requestKey, /^p1:[0-9a-f]{24}$/)
    const write = qwen.ask({ ...base, tool_name: 'write_file', tool_input: { file_path: '/w/a.txt', content: 'hi' } })!
    assert.equal(write.summary, '/w/a.txt\nhi')
    const edit = qwen.ask({ ...base, tool_name: 'edit', tool_input: { file_path: '/w/a.txt', old_string: 'a', new_string: 'b' } })!
    assert.equal(edit.summary, '/w/a.txt\n- a\n+ b')
  })

  test('a field the summary would leave out shows the whole input; other events stay in the terminal', () => {
    const run = qwen.ask({ ...base, tool_name: 'run_shell_command', tool_input: { command: 'make', directory: '/etc' } })!
    assert.match(run.summary, /"directory": "\/etc"/)
    assert.equal(qwen.ask({ ...base, hook_event_name: 'PreToolUse', tool_name: 'edit', tool_input: {} }), null)
    assert.equal(qwen.reply({ answer: 'allow', message: '' }), JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }))
    assert.equal(qwen.reply(PASS), '')
  })
})

describe('OpenCode asks', () => {
  test('a file change carries its diff; a command stays in the terminal', () => {
    // As OpenCode 2.2.5 sends a new file.
    const patch = 'Index: hello.txt\n===\n--- hello.txt\n+++ hello.txt\n@@ -0,0 +1,1 @@\n+hi\n'
    const files = [{ file: 'hello.txt', patch, status: 'added', additions: 1, deletions: 0 }]
    const edit = opencodeAsk({ id: 'per_1', sessionID: 'ses_1', action: 'edit', resources: ['hello.txt'], metadata: { files } })!
    assert.deepEqual([edit.tool, edit.summary, edit.complete, edit.requestKey], ['edit', patch, true, 'ses_1:per_1'])
    const joined = opencodeAsk({ id: 'per_4', sessionID: 'ses_1', action: 'edit', resources: ['a.txt'], metadata: { filepath: 'a.txt', diff: '-a\n+b\n' } })!
    assert.equal(joined.summary, '-a\n+b\n')
    const shell = opencodeAsk({ id: 'per_2', sessionID: 'ses_1', action: 'shell', resources: ['rm -rf build'] })!
    assert.equal(shell.complete, false)
    const fetch = opencodeAsk({ id: 'per_3', sessionID: 'ses_1', action: 'webfetch', resources: ['https://x.test'], metadata: { url: 'https://x.test' } })!
    assert.match(fetch.summary, /https:\/\/x\.test/)
    assert.equal(opencodeAsk({ action: 'edit' }), null)
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
