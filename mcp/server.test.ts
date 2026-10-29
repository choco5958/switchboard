import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { request } from 'node:http'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createBridge, listen } from '../bridge/server.ts'
import { toolDefs } from '../mod/hooks/tools.ts'
import { answerLine, mcpTools, createSession, parseOptions, takenText, type Reply } from './server.ts'

const dir = mkdtempSync(join(tmpdir(), 'sb-mcp-'))
const socketPath = join(dir, 'bridge.sock')
const bridge = createBridge(join(dir, 'ide.db'), undefined, { appKey: 'a'.repeat(64) })
const SERVER = join(import.meta.dirname, 'server.ts')
const children: ChildProcessWithoutNullStreams[] = []

function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { 'content-type': 'application/json', 'x-switchboard-app': 'a'.repeat(64) } }, res => {
      let text = ''
      res.on('data', chunk => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

// A scripted MCP client: the server runs as a child, as an agent CLI would start it.
// HOME points at an empty folder, so a missing bridge could never start the real one.
function client(args: string[]) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [SERVER, '--socket', socketPath, ...args], {
    cwd: '/tmp',
    env: { PATH: process.env.PATH ?? '', HOME: dir, CLAUDE_IDE_SOCKET: socketPath },
  })
  children.push(child)
  const waiting = new Map<number, (reply: any) => void>()
  createInterface({ input: child.stdout }).on('line', line => {
    const reply = JSON.parse(line)
    waiting.get(reply.id)?.(reply)
  })
  let next = 1
  return {
    child,
    request(method: string, params?: unknown): Promise<any> {
      const id = next++
      return new Promise(resolve => {
        waiting.set(id, resolve)
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    notify(method: string) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
    },
    async tool(name: string, args: unknown = {}): Promise<{ text: string; isError: boolean }> {
      const reply = await this.request('tools/call', { name, arguments: args })
      return { text: reply.result.content[0].text, isError: reply.result.isError }
    },
    close: () => new Promise<number | null>(resolve => {
      child.once('exit', code => resolve(code))
      child.stdin.end()
    }),
  }
}

before(async () => {
  await listen(bridge.server, socketPath)
  await call('POST', '/settings', { key: 'lang', value: 'ko' })
})
after(() => {
  for (const child of children) child.kill()
  bridge.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the MCP server against a test bridge', () => {
  test('initialize, tools/list with the mod schemas, and JSON-RPC errors', async () => {
    const c = client(['--agent', 'codex'])
    const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.equal(init.result.serverInfo.name, 'switchboard')
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } })
    c.notify('notifications/initialized')
    const old = await c.request('initialize', { protocolVersion: '1999-01-01' })
    assert.equal(old.result.protocolVersion, '2025-06-18')

    const list = await c.request('tools/list')
    const names = list.result.tools.map((t: { name: string }) => t.name)
    assert.deepEqual(names, ['ask_decision', 'set_task', 'plan_nodes', 'node_worktree', 'list_sessions', 'send_to_session', 'cancel_request', 'routine_no_update', 'routine_report_failure', 'await_event', 'close_wait', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_navigate', 'browser_console', 'browser_screenshot', 'update_node', 'open_in_ide', 'check_answers'])
    assert.deepEqual(list.result.tools[0].inputSchema, toolDefs('ko')[0]!.inputSchema)
    assert.deepEqual(list.result.tools[1].inputSchema, toolDefs('ko')[1]!.inputSchema)
    assert.equal(list.result.tools[1].description, toolDefs('ko')[1]!.description)
    assert.match(list.result.tools[0].description, /check_answers/)
    assert.doesNotMatch(list.result.tools[0].description, /AskUserQuestion/)

    assert.equal((await c.request('resources/list')).error.code, -32601)
    assert.equal((await c.request('tools/call', { name: 'nope' })).error.code, -32602)
    assert.deepEqual((await c.request('ping')).result, {})
    assert.equal(await c.close(), 0)
  })

  test('tools/call reaches the bridge as a codex session; an answer comes back once through check_answers', async () => {
    const c = client(['--agent', 'codex'])
    await c.request('initialize', { protocolVersion: '2025-06-18' })
    const task = await c.tool('set_task', { title: 'MCP 작업', stage: '작업', now: '도구 확인' })
    assert.equal(task.isError, false)
    const plan = await c.tool('plan_nodes', { task: 'MCP 작업', nodes: [{ key: 'a', title: '첫 노드' }] })
    assert.equal(plan.text, '노드 1개를 올렸습니다.')
    assert.match((await c.tool('update_node', { task: 'MCP 작업', key: 'a', status: '지금' })).text, /노드 a: 지금 \(1회차\)/)

    const asked = await c.tool('ask_decision', { task: 'MCP 작업', question: '어느 쪽으로 갈까', options: [{ key: 'a', label: '왼쪽' }, { key: 'b', label: '오른쪽' }] })
    const id = Number(/Q(\d+)/.exec(asked.text)?.[1])
    assert.ok(id > 0)
    assert.match(asked.text, /앱 밖에서 돌고 있어 답이 저절로 들어오지 않습니다.*check_answers/)

    const state = (await call('GET', '/state')).json
    const session = state.sessions.find((s: { agent: string }) => s.agent === 'codex')
    assert.deepEqual([session.cwd, session.terminal], [realpathSync('/tmp'), ''])
    assert.equal(state.tasks.find((t: { title: string }) => t.title === 'MCP 작업').session_id, session.id)

    assert.match((await c.tool('check_answers')).text, /새로 온 답이나 메시지가 없습니다/)
    // The route the app's answer button uses.
    assert.equal((await call('POST', `/questions/${id}/answer`, { choice: 'b', memo: '오른쪽이 가깝다' })).status, 200)
    const got = await c.tool('check_answers')
    assert.match(got.text, new RegExp(`\\[Switchboard\\] Q${id} 답이 왔습니다`))
    assert.match(got.text, /고른 것: \(b\) 오른쪽/)
    assert.match(got.text, /메모: 오른쪽이 가깝다/)
    assert.match((await c.tool('check_answers')).text, /새로 온 답이나 메시지가 없습니다/)
    const row = (await call('GET', '/state')).json.questions.find((q: { id: number }) => q.id === id)
    assert.equal(row.delivered, 1)
    assert.equal(await c.close(), 0)
  })

  test('a codex session lists the others, asks one, and reads the reply through check_answers', async () => {
    await call('POST', '/sessions', { id: 'peer-claude', cwd: '/w/api' })
    const c = client(['--agent', 'codex'])
    await c.request('initialize', { protocolVersion: '2025-06-18' })
    await c.tool('set_task', { title: '피어 작업' })
    const listed = await c.tool('list_sessions')
    assert.match(listed.text, /- peer-claude \| api \| claude \| \/w\/api \| 연결 끊김/)
    const sent = await c.tool('send_to_session', { to: ['peer-claude'], text: '스키마 알려줘' })
    const id = /m(\d+)/.exec(sent.text)?.[0]
    assert.ok(id)
    assert.match(sent.text, /턴을 끝내세요/)
    const self = (await call('GET', '/state')).json.sessions.find((s: { agent: string; id: string }) => s.agent === 'codex' && s.id !== 'peer-claude')
    // The other session answers it; the codex session reads the reply with check_answers.
    await call('POST', '/messages', { sessionId: 'peer-claude', replyTo: id, text: '상태: 완료\n결과: id, name' })
    const got = await c.tool('check_answers')
    assert.match(got.text, new RegExp(`이 세션이 보낸 요청 ${id}에 대한 답`))
    assert.match(got.text, /결과: id, name/)
    assert.ok(self)
    // A request it no longer needs: taken back before the other session got it.
    const again = await c.tool('send_to_session', { to: ['peer-claude'], text: '인덱스도 알려줘' })
    const second = /m(\d+)/.exec(again.text)?.[0]
    const cancelled = await c.tool('cancel_request', { ids: [second], reason: '필요 없어짐' })
    assert.match(cancelled.text, new RegExp(`${second}: 전달 전이라 들어가지 않습니다`))
    assert.match((await c.tool('cancel_request', { ids: ['m999999'] })).text, /이 세션이 보낸 요청이 아닙니다/)
    assert.equal(await c.close(), 0)
  })

  test('tool texts and answers follow the bridge language', async () => {
    await call('POST', '/settings', { key: 'lang', value: 'en' })
    try {
      const c = client(['--agent', 'qwen'])
      const list = await c.request('tools/list')
      assert.match(list.result.tools[0].description, /instead of asking in the chat/)
      const asked = await c.tool('ask_decision', { question: 'Ship it?', options: [{ key: 'a', label: 'Yes' }] })
      assert.match(asked.text, /^Posted as Q\d+/)
      const id = Number(/Q(\d+)/.exec(asked.text)?.[1])
      await call('POST', `/questions/${id}/answer`, { choice: 'a' })
      assert.match((await c.tool('check_answers')).text, new RegExp(`^\\[Switchboard\\] Q${id}`))
      assert.match((await c.tool('check_answers')).text, /No new answers/)
      await c.close()
    } finally {
      await call('POST', '/settings', { key: 'lang', value: 'ko' })
    }
  })

  test('in an app terminal the answer is said to come in as a prompt', async () => {
    const c = client(['--agent', 'gemini', '--terminal', 'r1-t4'])
    const asked = await c.tool('ask_decision', { question: '지금 배포할까', options: [{ key: 'a', label: '예' }] })
    assert.match(asked.text, /프롬프트가 입력됩니다/)
    const session = (await call('GET', '/state')).json.sessions.find((s: { terminal: string }) => s.terminal === 'r1-t4')
    assert.equal(session.agent, 'gemini')
    await c.close()
  })
})

describe('pieces of the MCP server', () => {
  test('flags win over env vars, and the defaults come from HOME', () => {
    const env = { HOME: '/h', SWITCHBOARD_AGENT: 'qwen', SWITCHBOARD_TERMINAL: 'r-t1' }
    assert.deepEqual(parseOptions(['--agent', 'Codex'], env, '/w'), { agent: 'codex', terminal: 'r-t1', cwd: '/w', socket: '/h/.claude-ide/bridge.sock', home: '/h' })
    assert.equal(parseOptions([], env, '/w').agent, 'qwen')
    assert.equal(parseOptions([], { HOME: '/h' }, '/w').agent, 'mcp')
  })

  test('taken items and prompt commands read as one prompt, the way the mod submits them', () => {
    assert.equal(takenText({ items: [], commands: [] }), '')
    assert.equal(takenText({ items: [{ id: 'q1', text: 'Q1 답' }] }), 'Q1 답')
    const both = takenText({ items: [{ id: 'q1', text: 'Q1 답' }], commands: [{ id: 3, kind: 'message', payload: { text: '천천히' } }] })
    assert.match(both, /2건이 도착했습니다/)
    assert.match(both, /\[Switchboard에서 온 말\] 천천히/)
  })

  test('a line may be a batch; notifications get no reply; broken JSON a parse error', async () => {
    const session = createSession(
      { agent: 'codex', terminal: '', cwd: '/w', socket: '/none', home: '/none' },
      { call: async () => ({ ok: false, status: 0, json: {} }), startBridge: async () => false, run: async () => ({ code: 1, stdout: '', stderr: '' }), log: () => undefined },
    )
    assert.equal((await answerLine('{', session.handle) as any).error.code, -32700)
    assert.equal(await answerLine('{"jsonrpc":"2.0","method":"notifications/initialized"}', session.handle), undefined)
    const batch = (await answerLine('[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/x"}]', session.handle)) as any[]
    assert.deepEqual(batch.map(r => r.id), [1])
  })

  test('a bridge that is down is started, and the session registers before the call goes again', async () => {
    let up = false
    const calls: string[] = []
    const session = createSession(
      { agent: 'codex', terminal: '', cwd: '/w', socket: '/none', home: '/none' },
      {
        call: async (method, path): Promise<Reply> => {
          calls.push(`${up ? 'up' : 'down'} ${path}`)
          return up ? { ok: true, status: 200, json: { count: 1, settings: { lang: 'ko' } } } : { ok: false, status: 0, json: { error: 'ENOENT' } }
        },
        startBridge: async () => (up = true),
        run: async () => ({ code: 1, stdout: '', stderr: '' }),
        log: () => undefined,
      },
    )
    const reply = (await session.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'plan_nodes', arguments: { task: 't', nodes: [{ key: 'a', title: 'x' }] } } }))!
    assert.equal((reply.result as any).content[0].text, '노드 1개를 올렸습니다.')
    assert.deepEqual(calls, ['down /sessions', 'up /sessions', 'up /state', 'up /nodes'])
  })

  test('every tool has a description and an object schema', () => {
    for (const tool of [...mcpTools('ko'), ...mcpTools('en')]) {
      assert.ok(tool.description.length > 20, tool.name)
      assert.equal(tool.inputSchema.type, 'object')
    }
  })
})
