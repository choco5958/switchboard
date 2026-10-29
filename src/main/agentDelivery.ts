import { request, type ClientRequest } from 'node:http'
import { parseFrame, takenText } from '../../mod/hooks/batch.ts'
import type { Reply, Session } from '../shared/types'
import { getLang, type Lang } from '../shared/i18n'
import { ENTER, ENTER_DELAY_MS, readyToType, typedInput, type TypingTarget } from './agentInput'

// Answers for agent CLIs that run in one of the app's terminals. The mod types
// answers into Claude Code itself; other CLIs have only their MCP server, which
// cannot reach the CLI's input. So the main process holds the session's delivery
// stream, and when something arrives and the CLI waits for input, takes it from
// the bridge (marking it delivered) and types it into the terminal as one prompt.

const RETRY_MS = 500
const RECONNECT_MS = 3000

export type DeliveryOptions = {
  socketPath: string
  call: (method: string, path: string, body?: unknown) => Promise<Reply>
  terminal: (key: string) => TypingTarget | undefined
  now?: () => number
  // The language the typed text is in, the `lang` setting like the mod's (the main process keeps it current).
  lang?: () => Lang
}

type Sub = { key: string; req: ClientRequest | null; timer: ReturnType<typeof setTimeout> | null; busy: boolean; closed: boolean }

// Sessions the app types for: not Claude Code, in a terminal of this app that is still open.
export function typedSessions(sessions: readonly Session[], terminal: (key: string) => TypingTarget | undefined): Session[] {
  return sessions.filter(s => s.agent && s.agent !== 'claude' && s.terminal && terminal(s.terminal)?.alive)
}

// Writes one prompt: the paste, then Enter after a pause. Returns false when there was nothing to type.
export function typePrompt(target: TypingTarget, text: string, later: (fn: () => void, ms: number) => void = setTimeout): boolean {
  if (!text.trim()) return false
  target.write(typedInput(text, target.paste))
  later(() => target.write(ENTER), ENTER_DELAY_MS)
  return true
}

export function startAgentDelivery(options: DeliveryOptions) {
  const now = options.now ?? Date.now
  const lang = options.lang ?? getLang
  const subs = new Map<string, Sub>()

  const flush = async (sessionId: string): Promise<void> => {
    const sub = subs.get(sessionId)
    if (!sub || sub.closed || sub.busy) return
    sub.timer = null
    const target = options.terminal(sub.key)
    if (!target?.alive) return
    if (!readyToType(target, now())) {
      sub.timer = setTimeout(() => void flush(sessionId), RETRY_MS)
      return
    }
    sub.busy = true
    try {
      // Typed first, acknowledged after: what a terminal that closed in between did not get
      // stays undelivered, for the session's next start (codex resume and the like).
      const reply = await options.call('POST', '/deliveries/take', { sessionId, hold: true })
      const still = options.terminal(sub.key)
      if (reply.ok && still?.alive && typePrompt(still, takenText(reply.json, lang()))) {
        for (const item of (reply.json.items ?? []) as { id: string }[]) await options.call('POST', `/deliveries/${item.id}/ack`)
      }
    } finally {
      sub.busy = false
    }
  }

  const schedule = (sessionId: string) => {
    const sub = subs.get(sessionId)
    if (sub && !sub.timer && !sub.busy) sub.timer = setTimeout(() => void flush(sessionId), 0)
  }

  const listen = (sessionId: string, sub: Sub) => {
    const req = request({ socketPath: options.socketPath, path: `/deliveries?session=${encodeURIComponent(sessionId)}` }, res => {
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        let end = buffer.indexOf('\n\n')
        while (end !== -1) {
          const frame = parseFrame(buffer.slice(0, end))
          buffer = buffer.slice(end + 2)
          end = buffer.indexOf('\n\n')
          if (frame && (frame.event === 'delivery' || frame.event === 'command')) schedule(sessionId)
        }
      })
      res.on('close', lost)
    })
    let gone = false
    function lost() {
      if (gone) return
      gone = true
      sub.req = null
      if (!sub.closed) setTimeout(() => !sub.closed && !sub.req && listen(sessionId, sub), RECONNECT_MS).unref?.()
    }
    req.on('error', lost)
    req.on('close', lost)
    req.end()
    sub.req = req
  }

  const close = (sessionId: string) => {
    const sub = subs.get(sessionId)
    if (!sub) return
    sub.closed = true
    if (sub.timer) clearTimeout(sub.timer)
    sub.req?.destroy()
    subs.delete(sessionId)
  }

  // Holds a stream for exactly the sessions the app types for.
  const sync = (sessions: readonly Session[]) => {
    const wanted = new Map(typedSessions(sessions, options.terminal).map(s => [s.id, s.terminal ?? '']))
    for (const id of [...subs.keys()]) if (!wanted.has(id) || subs.get(id)?.key !== wanted.get(id)) close(id)
    for (const [id, key] of wanted) {
      if (subs.has(id)) continue
      const sub: Sub = { key, req: null, timer: null, busy: false, closed: false }
      subs.set(id, sub)
      listen(id, sub)
    }
  }

  let refreshing = false
  const refresh = async () => {
    if (refreshing) return
    refreshing = true
    try {
      const reply = await options.call('GET', '/state')
      if (reply.ok) sync((reply.json.sessions ?? []) as Session[])
    } finally {
      refreshing = false
    }
  }

  const tick = setInterval(() => void refresh(), 15_000)
  tick.unref?.()

  return {
    sync,
    refresh,
    // Bridge change events: a session registering may be one to type for.
    onBridgeEvent: (event: unknown) => {
      const type = (event as { type?: string } | null)?.type
      if (type === 'connected' || type === 'sessions') void refresh()
    },
    sessions: () => [...subs.keys()],
    stop: () => {
      clearInterval(tick)
      for (const id of [...subs.keys()]) close(id)
    },
  }
}
