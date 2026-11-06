// OpenCode 2's permission relay: a plugin the app adds to one run (src/shared/agents.ts, the
// OpenCode preset), loaded into that run's own server. OpenCode takes a local plugin as a folder
// and loads its server file (packages/plugin/src/host.ts), so this one has a folder of its own. It sends each ask OpenCode shows to the
// MCP server of the same run, which posts it to the bridge while the person is away, and replies
// with the person's answer. The ask stays on screen meanwhile; answered there first, it is
// withdrawn. Anything amiss leaves the ask to the terminal.
// It also tells that server how the turn goes (docs/에이전트-대등하게.md): the run starting, its tools,
// and the end with the turn's last text (OpenCode 2.2.5's session events, tested). A subagent runs
// as a session of its own inside the turn, so only the first session's end ends the turn.
import { homedir } from 'node:os'
import { askServer, tellServer } from '../hook.ts'
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
    // The sessions running now, the turn's own first, and the last text each wrote.
    const running: string[] = []
    const lastText = new Map<string, string>()
    const turn = (data: Record<string, unknown>, type: string) => {
      const sessionID = String(data.sessionID ?? '')
      if (type === 'session.execution.started') {
        if (!running.includes(sessionID)) running.push(sessionID)
        if (running.length === 1) void tellServer(path, terminal, { kind: 'turnStart' })
      } else if (type === 'session.tool.called') void tellServer(path, terminal, { kind: 'toolStart' })
      else if (type === 'session.tool.success' || type === 'session.tool.failed') void tellServer(path, terminal, { kind: 'toolEnd' })
      else if (type === 'session.text.ended' && typeof data.text === 'string') lastText.set(sessionID, data.text)
      else if (type.startsWith('session.execution.')) {
        const first = running[0] === sessionID
        const at = running.indexOf(sessionID)
        if (at >= 0) running.splice(at, 1)
        const answer = lastText.get(sessionID) ?? ''
        lastText.delete(sessionID)
        if (first) void tellServer(path, terminal, { kind: 'turnEnd', answer, aborted: type !== 'session.execution.succeeded' })
      }
    }
    const types = ['permission.asked', 'permission.replied', 'session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.tool.called', 'session.tool.success', 'session.tool.failed', 'session.text.ended']
    void (async () => {
      for await (const event of ctx.event.subscribe({ types, signal: stop.signal })) {
        const data = event.data ?? {}
        if (event.type === 'permission.asked') asked(data)
        else if (event.type === 'permission.replied') pending.get(String(data.requestID))?.abort()
        else turn(data, event.type)
      }
    })().catch(() => {})
    return () => {
      stop.abort()
      for (const withdrawn of pending.values()) withdrawn.abort()
    }
  },
}
