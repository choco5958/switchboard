import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { agentSources, codexNames, crushSessions, cursorSessions, opencodeSessions, parseCodex, parseCopilot, parseGemini, parseQwen } from './agentHistory'
import { loadFrom } from './sessionHistory'
import { presetLaunch, presetOf } from '../shared/agents'

const lines = (...records: unknown[]) => records.map(r => JSON.stringify(r)).join('\n') + '\n'
const whole = (head: string, side?: { title?: string; cwd?: string }) => ({ path: '/x', id: 'from-name', folder: 'f', size: head.length, mtime: 5, head, tail: '', whole: true, ...(side ? { side } : {}) })
const ID = '01a1af4c-4f95-77e2-ba3a-9331b63455c1'

// The records as each CLI wrote them on this computer (shapes only, the words made up).
describe('reading other CLIs conversations', () => {
  test('Codex: what Codex adds to the turn is left out; only terminal and editor runs resume', () => {
    const meta = (source: unknown) => ({ type: 'session_meta', payload: { id: ID, cwd: '/w/app', source } })
    const user = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
    const said = lines(
      meta('cli'),
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] } },
      user('<environment_context>\n  <cwd>/w/app</cwd>\n</environment_context>'),
      user('# AGENTS.md instructions for /w/app'),
      user('fix the login bug'),
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed it.' }] } },
    )
    expect(parseCodex(whole(said))).toMatchObject({ id: ID, agent: 'codex', cwd: '/w/app', project: 'app', title: 'fix the login bug', snippet: 'Fixed it.', messages: 2 })
    // Its own name for the conversation wins.
    expect(parseCodex(whole(said, { title: 'Login fix' }))!.title).toBe('Login fix')
    expect(parseCodex(whole(said.replace('"cli"', '"exec"')))).toBeNull()
    expect(parseCodex(whole(said.replace('"cli"', '{"subagent":"x"}')))).toBeNull()
    expect(codexNames(lines({ id: 'a', thread_name: 'one' }, { id: 'a', thread_name: 'two' }, { id: 'b', thread_name: '' }))).toEqual(new Map([['a', 'two']]))
  })

  test('Copilot, Qwen and Gemini', () => {
    const copilot = lines(
      { type: 'session.start', data: { sessionId: 's', context: { cwd: '/w/api', branch: 'main' } } },
      { type: 'user.message', data: { content: 'add a test' } },
      { type: 'assistant.message', data: { content: '' } },
      { type: 'assistant.message', data: { content: 'Added.' } },
    )
    expect(parseCopilot({ ...whole(copilot), id: 'cfdf763a-f600-4c5e-a83c-ac12c44f4bb4' })).toMatchObject({ agent: 'copilot', cwd: '/w/api', branch: 'main', title: 'add a test', snippet: 'Added.', messages: 2 })
    const qwen = lines(
      { type: 'user', cwd: '/w/q', message: { role: 'user', parts: [{ text: 'hello' }] } },
      { type: 'system', subtype: 'memory_catalog_snapshot', cwd: '/w/q', message: { role: 'user', parts: [{ text: 'memory' }] } },
      { type: 'assistant', cwd: '/w/q', message: { role: 'model', parts: [{ text: 'hi there' }] } },
    )
    expect(parseQwen({ ...whole(qwen), id: '62c9e046-e7c6-406f-831c-28e875c53afa' })).toMatchObject({ agent: 'qwen', cwd: '/w/q', title: 'hello', snippet: 'hi there', messages: 2 })
    const gemini = lines(
      { sessionId: '367b71a0-74a9-4128-90f5-3b5858fccb7c', projectHash: 'h', startTime: 't', kind: 'main' },
      { type: 'user', content: [{ text: '<session_context>\nThis is the Gemini CLI.' }] },
      { type: 'user', content: [{ text: 'what changed?' }] },
      { type: 'info', content: 'MCP issues detected.' },
      { type: 'gemini', content: 'Two files.' },
    )
    expect(parseGemini(whole(gemini, { cwd: '/w/g' }))).toMatchObject({ id: '367b71a0-74a9-4128-90f5-3b5858fccb7c', agent: 'gemini', cwd: '/w/g', title: 'what changed?', snippet: 'Two files.', messages: 2 })
    // Nothing said: no conversation to go on with.
    expect(parseGemini(whole(lines({ sessionId: '367b71a0-74a9-4128-90f5-3b5858fccb7c' })))).toBeNull()
  })

  test('a resume goes first on the line, a subcommand for Codex', () => {
    const server = { command: 'node', args: ['/s.mjs'] }
    expect(presetLaunch(presetOf('codex')!, server, '/a/x.json', 'darwin', undefined, null, ID).line).toMatch(new RegExp(`^codex resume ${ID} -c `))
    expect(presetLaunch(presetOf('qwen')!, server, '/a/x.json', 'darwin', undefined, null, 'abc').line).toMatch(/^qwen --resume abc --mcp-config /)
    expect(presetLaunch(presetOf('qwen')!, server, '/a/x.json', 'darwin').line).not.toContain('--resume')
    expect(presetOf('goose')!.resumeArgs).toBeUndefined()
  })
})

describe('finding them on disk', () => {
  let home = ''
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  test('each CLI in its own folder, newest first, under the homes it reads', async () => {
    home = mkdtempSync(join(tmpdir(), 'sb-hist-'))
    const put = (path: string, text: string) => {
      mkdirSync(join(home, path, '..'), { recursive: true })
      writeFileSync(join(home, path), text)
    }
    put(`.codex/sessions/2026/11/05/rollout-2026-11-05T17-40-19-${ID}.jsonl`, lines({ type: 'session_meta', payload: { id: ID, cwd: '/w/c', source: 'cli' } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex words' }] } }))
    put('.codex/session_index.jsonl', lines({ id: ID, thread_name: 'Named in Codex' }))
    put('.copilot/session-state/cfdf763a-f600-4c5e-a83c-ac12c44f4bb4/events.jsonl', lines({ type: 'user.message', data: { content: 'copilot words' } }))
    put('.copilot/session-state/cfdf763a-f600-4c5e-a83c-ac12c44f4bb4/workspace.yaml', 'id: x\nname: Named in Copilot\n')
    put('.qwen/projects/-w-q/chats/62c9e046-e7c6-406f-831c-28e875c53afa.jsonl', lines({ type: 'user', cwd: '/w/q', message: { parts: [{ text: 'qwen words' }] } }))
    put('.qwen/projects/-w-q/chats/62c9e046-e7c6-406f-831c-28e875c53afa.runtime.json', '{}')
    put('.gemini/tmp/proj/.project_root', '/w/g\n')
    put('.gemini/tmp/proj/chats/session-2026-11-06T06-35-367b71a0.jsonl', lines({ sessionId: '367b71a0-74a9-4128-90f5-3b5858fccb7c' }, { type: 'user', content: [{ text: 'gemini words' }] }))
    const { total, sessions } = await loadFrom(agentSources({}, home))
    expect(total).toBe(4)
    expect(Object.fromEntries(sessions.map(s => [s.agent, [s.title, s.cwd]]))).toEqual({
      codex: ['Named in Codex', '/w/c'],
      copilot: ['Named in Copilot', ''],
      qwen: ['qwen words', '/w/q'],
      gemini: ['gemini words', '/w/g'],
    })
    // CODEX_HOME and GEMINI_CLI_HOME stand for their folders.
    expect((await loadFrom(agentSources({ CODEX_HOME: join(home, 'none') }, home))).sessions.some(s => s.agent === 'codex')).toBe(false)
  })
})

describe('the CLIs that keep a database', () => {
  let home = ''
  afterEach(() => rmSync(home, { recursive: true, force: true }))
  const db = (path: string, sql: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    const d = new DatabaseSync(path)
    d.exec(sql)
    d.close()
  }

  test('OpenCode 2: top sessions with their words; a subagent or archived one is left out', () => {
    home = mkdtempSync(join(tmpdir(), 'sb-oc-'))
    const path = join(home, 'opencode.db')
    db(path, `create table session_v2 (id text, parent_id text, directory text, title text, time_updated integer, time_archived integer);
      create table session_message (id text, session_id text, type text, seq integer, data text);
      insert into session_v2 values ('ses_abc', null, '/w/oc', 'Fix tests', 7, null), ('ses_kid', 'ses_abc', '/w/oc', 'sub', 8, null), ('ses_old', null, '/w/oc', 'old', 9, 5);
      insert into session_message values ('m1', 'ses_abc', 'user', 1, '{"text":"run the tests"}'), ('m2', 'ses_abc', 'assistant', 2, '{"content":[{"type":"text","text":"All pass."}]}'), ('m3', 'ses_abc', 'idle', 3, '{}');`)
    const found = opencodeSessions(path)
    expect(found.map(f => f.ready)).toMatchObject([{ id: 'ses_abc', agent: 'opencode', cwd: '/w/oc', title: 'Fix tests', snippet: 'All pass.', messages: 2, updatedAt: 7 }])
    expect(opencodeSessions(join(home, 'none.db'))).toEqual([])
  })

  test('Cursor: a chat that said something, by its name; Crush: the app data folders that know their project', async () => {
    home = mkdtempSync(join(tmpdir(), 'sb-cu-'))
    const chat = join(home, 'chats', 'ws1', '24bb23ff-45a8-45c6-b9e1-dca6491116a5')
    db(join(chat, 'store.db'), `create table meta (key text, value text); insert into meta values ('0', '${Buffer.from(JSON.stringify({ name: 'Refactor login', createdAt: 1 })).toString('hex')}');`)
    writeFileSync(join(chat, 'meta.json'), JSON.stringify({ cwd: '/w/cu', hasConversation: true, updatedAtMs: 11 }))
    const empty = join(home, 'chats', 'ws1', '00000000-0000-0000-0000-000000000000')
    mkdirSync(empty, { recursive: true })
    writeFileSync(join(empty, 'meta.json'), JSON.stringify({ cwd: '/w/cu', hasConversation: false, updatedAtMs: 12 }))
    expect((await cursorSessions(join(home, 'chats'))).map(f => f.ready)).toMatchObject([{ agent: 'cursor', cwd: '/w/cu', title: 'Refactor login', messages: 0, updatedAt: 11 }])
    const folder = join(home, 'agents', 'crush', '0123456789abcdef')
    db(join(folder, 'crush.db'), `create table sessions (id text, parent_session_id text, title text, message_count integer, updated_at integer);
      create table messages (id text, session_id text, role text, parts text, created_at integer);
      insert into sessions values ('d3aaff7d-8ced-47d7-9b8d-b89c6687df37', null, 'Write hello', 4, 100);
      insert into messages values ('x', 'd3aaff7d-8ced-47d7-9b8d-b89c6687df37', 'assistant', '[{"type":"text","data":{"text":"Done."}},{"type":"finish","data":{}}]', 99);`)
    // No record of the project yet (a folder from before it was kept): left out.
    expect(await crushSessions(join(home, 'agents', 'crush'))).toEqual([])
    writeFileSync(join(folder, 'cwd'), '/w/cr')
    expect((await crushSessions(join(home, 'agents', 'crush'))).map(f => f.ready)).toMatchObject([{ agent: 'crush', cwd: '/w/cr', title: 'Write hello', snippet: 'Done.', messages: 4, updatedAt: 100_000 }])
    // Through the sources, as the past sessions page reads them.
    const all = await loadFrom(agentSources({ XDG_DATA_HOME: join(home, 'none') }, join(home, 'nohome'), join(home, 'agents')))
    expect(all.sessions.map(s => s.agent)).toEqual(['crush'])
  })

  test('their resume flags', () => {
    const server = { command: 'node', args: ['/s.mjs'] }
    expect(presetLaunch(presetOf('opencode')!, server, '/a/x.json', 'darwin', undefined, '2.2.5', 'ses_abc').line).toBe('opencode --session ses_abc --standalone')
    expect(presetLaunch(presetOf('cursor')!, server, '/a/x.json', 'darwin', undefined, null, 'abc').line).toMatch(/^cursor-agent --resume abc /)
    expect(presetLaunch(presetOf('crush')!, server, '/a/crush.json', 'darwin', undefined, null, 'abc').line).toMatch(/^crush --session abc -D /)
  })
})
