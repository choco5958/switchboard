#!/usr/bin/env node
// switchboard: the bridge from a shell. Give a session work, wait for its result, read and
// answer the decision queue. `pnpm run setup` links it as ~/.local/bin/switchboard.
//
//   switchboard sessions
//   switchboard send <session|project> <text | -> [--wait] [--timeout 30m] [--info] [--json]
//   switchboard status <m12>
//   switchboard decisions [--json]
//   switchboard answer <Q12> <key | -> [memo]     (not inside an agent session)
//   switchboard waits
//   switchboard fire <w3> [what happened | -]     (a session's await_event)
//
// Exit codes, as in OpenBot's script CLI: 0 done, 1 failed, 2 wrong command line or two
// sessions match, 3 the session waits for a person (a decision question it posted since the
// message), 4 the wait timed out (the session keeps working), 5 the bridge is not running or
// the session is unknown.
//
// Nothing here carries the app's key, so the bridge marks what this sends as coming from a
// shell command, which another session may run too: the session reads it fenced, as
// collaborator input, and an answer to a decision says it came from the shell.

import { request } from 'node:http'
import { requestTarget, resolveEndpoint } from '../bridge/endpoint.ts'

export const EXIT = { done: 0, failed: 1, usage: 2, person: 3, timeout: 4, unreachable: 5 } as const

type Reply = { status: number; json: Record<string, unknown> }
type Call = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<Reply>

const bridgeCall: Call = (method, path, body) =>
  new Promise((resolve, reject) => {
    const target = requestTarget(resolveEndpoint())
    const req = request({ ...target, method, path, headers: { ...target.headers, 'content-type': 'application/json' } }, res => {
      let text = ''
      res.on('data', chunk => (text += chunk))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} })
        } catch {
          resolve({ status: res.statusCode ?? 0, json: { error: text } })
        }
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })

// "90s", "5m", "2h"; a bare number is seconds.
export function duration(text: string): number | null {
  const match = /^(\d+)(s|m|h)?$/.exec(text.trim())
  if (!match) return null
  return Number(match[1]) * ({ s: 1000, m: 60_000, h: 3_600_000 }[match[2] as 's' | 'm' | 'h'] ?? 1000)
}

export type Peer = { id: string; project: string; cwd: string; agent: string; live: boolean; state: string; task: string; now: string }

// A session by its id, or by its project when one connected session has it.
export function resolveSession(peers: readonly Peer[], name: string): { id: string } | { error: 'none' | 'many'; ids: string[] } {
  if (peers.some(p => p.id === name)) return { id: name }
  const byProject = peers.filter(p => p.project === name)
  const live = byProject.filter(p => p.live)
  const pick = live.length > 0 ? live : byProject
  if (pick.length === 1) return { id: pick[0]!.id }
  return { error: pick.length === 0 ? 'none' : 'many', ids: pick.map(p => p.id) }
}

export type Parsed = { command: string; args: string[]; flags: Record<string, string | true> }

export function parseArgs(argv: readonly string[]): Parsed {
  const args: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--timeout') flags.timeout = argv[++i] ?? ''
    else if (arg.startsWith('--')) flags[arg.slice(2)] = true
    else args.push(arg)
  }
  return { command: args[0] ?? '', args: args.slice(1), flags }
}

const USAGE = `switchboard sessions
switchboard send <session|project> <text | -> [--wait] [--timeout 30m] [--info] [--json]
switchboard status <m12>
switchboard decisions [--json]
switchboard answer <Q12> <key | -> [memo]
switchboard waits
switchboard fire <w3> [what happened | -]`

// `env`: the environment, to tell an agent session's shell (agentSession).
type Io = {
  out: (text: string) => void
  err: (text: string) => void
  stdin: () => Promise<string>
  sleep: (ms: number) => Promise<void>
  now: () => number
  env?: Record<string, string | undefined>
}

// A shell an agent runs commands in: Claude Code sets CLAUDECODE there, and the app's terminals
// set SWITCHBOARD_AGENT for the agent CLIs they start.
export function agentSession(env: Record<string, string | undefined>): boolean {
  return Boolean(env.CLAUDECODE || env.SWITCHBOARD_AGENT)
}

export async function run(argv: readonly string[], call: Call, io: Io): Promise<number> {
  const { command, args, flags } = parseArgs(argv)
  const json = flags.json === true
  const print = (value: unknown, text: string) => io.out(json ? JSON.stringify(value) : text)
  const fail = (code: number, error: string) => {
    if (json) io.out(JSON.stringify({ ok: false, exitCode: code, error }))
    else io.err(error)
    return code
  }
  let reply: Reply
  const ask = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply | null> => {
    try {
      reply = await call(method, path, body)
      return reply
    } catch {
      return null
    }
  }

  if (command === 'sessions') {
    const r = await ask('GET', '/sessions/peers')
    if (!r) return fail(EXIT.unreachable, 'the bridge is not running')
    const peers = (r.json.peers ?? []) as Peer[]
    print(peers, peers.map(p => `${p.live ? '●' : '○'} ${p.id}  ${p.project}  ${p.agent}${p.task ? `  ${p.task}${p.now ? `: ${p.now}` : ''}` : ''}`).join('\n') || 'no sessions')
    return EXIT.done
  }

  if (command === 'decisions') {
    const r = await ask('GET', '/state')
    if (!r) return fail(EXIT.unreachable, 'the bridge is not running')
    const open = ((r.json.questions ?? []) as { id: number; status: string; project: string; task_title: string; question: string; options: string; recommend: string }[])
      .filter(q => q.status !== 'answered')
      .sort((a, b) => a.id - b.id)
    const lines = open.map(q => {
      const options = (JSON.parse(q.options || '[]') as { key: string; label: string }[]).map(o => `(${o.key}) ${o.label}${o.key === q.recommend ? ' *' : ''}`).join('  ')
      return `Q${q.id} [${q.task_title || q.project}]${q.status === 'held' ? ' (held)' : ''} ${q.question}\n    ${options}`
    })
    print(open, lines.join('\n') || 'no open decisions')
    return EXIT.done
  }

  if (command === 'answer') {
    const id = Number((args[0] ?? '').replace(/^q/i, ''))
    const choice = args[1] === '-' ? '' : (args[1] ?? '')
    const memo = args.slice(2).join(' ')
    if (!id || (!choice && !memo)) return fail(EXIT.usage, USAGE)
    // A speed bump, not a lock: a decision is the person's, and a session told to answer another
    // one's would do it here. The bridge marks shell answers either way (deliveryText).
    if (agentSession(io.env ?? {})) {
      return fail(EXIT.failed, 'switchboard answer does not run inside an agent session (CLAUDECODE or SWITCHBOARD_AGENT is set). Answer in the Switchboard app, or from a terminal of your own.')
    }
    const r = await ask('POST', `/questions/${id}/answer`, { choice, memo })
    if (!r) return fail(EXIT.unreachable, 'the bridge is not running')
    if (r.status !== 200) return fail(r.status === 404 ? EXIT.unreachable : EXIT.failed, String(r.json.error ?? r.status))
    print({ ok: true, id }, `answered Q${id}`)
    return EXIT.done
  }

  if (command === 'waits') {
    const r = await ask('GET', '/waits')
    if (!r) return fail(EXIT.unreachable, 'the bridge is not running')
    const waits = (r.json.waits ?? []) as { id: number; project: string | null; session_id: string; note: string }[]
    print(waits, waits.map(w => `w${w.id} [${w.project ?? w.session_id}] ${w.note.split('\n')[0]}`).join('\n') || 'no open waits')
    return EXIT.done
  }

  if (command === 'fire') {
    const id = (args[0] ?? '').replace(/^w/, '')
    if (!/^\d+$/.test(id)) return fail(EXIT.usage, USAGE)
    const payload = args.length === 2 && args[1] === '-' ? await io.stdin() : args.slice(1).join(' ')
    const r = await ask('POST', `/waits/${id}/fire`, { payload })
    if (!r) return fail(EXIT.unreachable, 'the bridge is not running')
    // Reached, but refused (no such wait, already fired): a failure, not a bridge that is down.
    if (r.status !== 200) return fail(EXIT.failed, String(r.json.error ?? r.status))
    print({ ok: true, id: `w${id}` }, `fired w${id}`)
    return EXIT.done
  }

  if (command === 'status') {
    const id = (args[0] ?? '').replace(/^m/, '')
    if (!id) return fail(EXIT.usage, USAGE)
    return status(id, false)
  }

  if (command === 'send') {
    const [name, ...words] = args
    if (!name || words.length === 0) return fail(EXIT.usage, USAGE)
    const text = words.length === 1 && words[0] === '-' ? await io.stdin() : words.join(' ')
    if (!text.trim()) return fail(EXIT.usage, 'nothing to send')
    const timeout = flags.timeout === undefined ? 30 * 60_000 : duration(String(flags.timeout))
    if (timeout === null) return fail(EXIT.usage, `bad --timeout: ${String(flags.timeout)}`)
    const peers = await ask('GET', '/sessions/peers')
    if (!peers) return fail(EXIT.unreachable, 'the bridge is not running')
    const target = resolveSession((peers.json.peers ?? []) as Peer[], name)
    if ('error' in target) {
      return target.error === 'none'
        ? fail(EXIT.unreachable, `no session or project named ${name}`)
        : fail(EXIT.usage, `${name} matches several sessions: ${target.ids.join(', ')}`)
    }
    const wait = flags.wait === true
    const sent = await ask('POST', '/outbox', { sessionId: target.id, text, kind: '메시지', expectsReply: !flags.info })
    if (!sent) return fail(EXIT.unreachable, 'the bridge is not running')
    if (sent.status !== 200) return fail(EXIT.failed, String(sent.json.error ?? sent.status))
    const id = String(sent.json.id).replace(/^m/, '')
    if (!wait) {
      print({ ok: true, id: `m${id}`, sessionId: target.id }, `m${id}`)
      return EXIT.done
    }
    const until = io.now() + timeout
    for (;;) {
      const code = await status(id, true)
      if (code !== -1) return code
      if (io.now() >= until) return fail(EXIT.timeout, `m${id}: no result within ${String(flags.timeout ?? '30m')}; the session keeps working (switchboard status m${id})`)
      await io.sleep(2000)
    }
  }

  return fail(EXIT.usage, USAGE)

  // One look at a message. While waiting, -1 means: nothing yet, look again.
  async function status(id: string, waiting: boolean): Promise<number> {
    const r = await ask('GET', `/messages/${id}`)
    if (!r) return waiting ? -1 : fail(EXIT.unreachable, 'the bridge is not running')
    if (r.status === 404) return fail(EXIT.unreachable, String(r.json.error ?? 'unknown message'))
    // A bridge in trouble (5xx) may answer next time; any other refusal will not.
    if (r.status !== 200) return waiting && r.status >= 500 ? -1 : fail(EXIT.failed, String(r.json.error ?? `bridge answered ${r.status}`))
    const s = r.json as { answered: boolean; reply: string | null; delivered: boolean; live: boolean; questions: { id: number; question: string }[] }
    if (s.answered && s.reply !== null) {
      print({ ok: true, id: `m${id}`, reply: s.reply }, s.reply)
      return EXIT.done
    }
    if (Array.isArray(s.questions) && s.questions.length > 0) {
      const text = s.questions.map(q => `Q${q.id} ${q.question}`).join('\n')
      if (json) io.out(JSON.stringify({ ok: false, exitCode: EXIT.person, questions: s.questions }))
      else io.err(`the session waits for a decision (switchboard decisions):\n${text}`)
      return EXIT.person
    }
    if (waiting) return -1
    print({ ok: true, id: `m${id}`, delivered: s.delivered, live: s.live }, s.delivered ? 'delivered, working' : s.live ? 'waiting for the turn to end' : 'waiting for the session to connect')
    return EXIT.done
  }
}

const stdin = () =>
  new Promise<string>(resolve => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => (text += chunk))
    process.stdin.on('end', () => resolve(text))
  })

if (import.meta.main) {
  const code = await run(process.argv.slice(2), bridgeCall, {
    out: text => process.stdout.write(`${text}\n`),
    err: text => process.stderr.write(`${text}\n`),
    stdin,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    env: process.env,
  })
  // Not process.exit: output to a pipe is written asynchronously, and exiting at once cuts what
  // is past the first 64 KiB. Nothing else is left running, so the process ends by itself.
  process.exitCode = code
}
