// OpenCode 2's permission relay: a plugin the app adds to one run (src/shared/agents.ts, the
// OpenCode preset), loaded into that run's own server. OpenCode takes a local plugin as a folder
// and loads its server file (packages/plugin/src/host.ts), so this one has a folder of its own. It sends each ask OpenCode shows to the
// MCP server of the same run, which posts it to the bridge while the person is away, and replies
// with the person's answer. The ask stays on screen meanwhile; answered there first, it is
// withdrawn. Anything amiss leaves the ask to the terminal.
import { homedir } from 'node:os'
import { askServer } from '../hook.ts'
import { HOOK_WAIT_MS, hookSocket, opencodeAsk } from '../permission.ts'

type Event = { type: string; data?: Record<string, unknown> }
type Context = {
  event: { subscribe: (options: { types: string[]; signal: AbortSignal }) => AsyncIterable<Event> }
  permission: { reply: (input: { sessionID: string; requestID: string; decision: 'once' | 'reject'; message?: string }) => Promise<unknown> }
}

export default {
  id: 'switchboard.permission',
  setup: (ctx: Context) => {
    const terminal = process.env.SWITCHBOARD_TERMINAL ?? ''
    if (!terminal) return
    const path = hookSocket(process.env.HOME || homedir(), terminal)
    const stop = new AbortController()
    const pending = new Map<string, AbortController>()
    const asked = (data: Record<string, unknown>) => {
      const ask = opencodeAsk(data)
      if (!ask) return
      const requestID = String(data.id)
      const sessionID = String(data.sessionID ?? '')
      const withdrawn = new AbortController()
      pending.set(requestID, withdrawn)
      void askServer(path, terminal, ask, HOOK_WAIT_MS, withdrawn.signal).then(answer => {
        pending.delete(requestID)
        if (answer.answer === 'ask' || withdrawn.signal.aborted) return
        const decision = answer.answer === 'allow' ? 'once' : 'reject'
        ctx.permission.reply({ sessionID, requestID, decision, ...(answer.message ? { message: answer.message } : {}) }).catch(() => {})
      })
    }
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: ['permission.asked', 'permission.replied'], signal: stop.signal })) {
        const data = event.data ?? {}
        if (event.type === 'permission.asked') asked(data)
        else if (event.type === 'permission.replied') pending.get(String(data.requestID))?.abort()
      }
    })().catch(() => {})
    return () => {
      stop.abort()
      for (const withdrawn of pending.values()) withdrawn.abort()
    }
  },
}
