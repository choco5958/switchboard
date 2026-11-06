// Codex runs a hook only once its exact definition is recorded as trusted (hooks.state in
// ~/.codex/config.toml, keyed by where the hook came from and hashed by Codex). With the relay
// turned on (agents.ts CODEX_APPROVALS_KEY), the app has Codex itself record Switchboard's
// hooks (the permission ask and the turn's events) before it opens a Codex terminal: `codex app-server` with the same -c value
// lists the hook with its hash (hooks/list) and writes the trust (config/batchWrite), as Codex's
// own /hooks review does. Nothing else in the file changes, and no hook runs untrusted
// (--dangerously-bypass-hook-trust would let every hook of the run do so).
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

type Json = Record<string, unknown>
const object = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})

// Switchboard's hooks as hooks/list names their events (agents.ts CODEX_EVENTS; 0.166, tested).
export const CODEX_HOOK_EVENTS = ['permissionRequest', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop']

// From the hooks/list reply: true when Switchboard's hooks are all trusted already, the hooks.state
// values to write for those that are not, null when the list does not hold one of them (Codex
// changed, or the relay cannot be set up: the terminal then opens without the hooks).
export function planTrust(list: unknown, command: string): true | Json | null {
  const data = object(list).data
  const hooks = Array.isArray(data) ? data.flatMap(entry => (Array.isArray(object(entry).hooks) ? (object(entry).hooks as unknown[]) : [])) : []
  const mine = CODEX_HOOK_EVENTS.map(event => hooks.map(object).find(h => h.source === 'sessionFlags' && h.eventName === event && h.command === command))
  if (mine.some(h => !h || typeof h.key !== 'string' || typeof h.currentHash !== 'string')) return null
  const untrusted = (mine as Json[]).filter(h => h.trustStatus !== 'trusted')
  if (untrusted.length === 0) return true
  return Object.fromEntries(untrusted.map(h => [h.key as string, { trusted_hash: h.currentHash }]))
}

// `codex`: how to start it (agentDetect.ts cliBins: an npm-installed one runs with node).
export function trustCodexHook(codex: string[], overrides: string[], command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const child = spawn(codex[0]!, [...codex.slice(1), 'app-server', ...overrides.flatMap(value => ['-c', value])], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.on('error', () => finish(false))
    child.on('exit', () => finish(false))
    let next = 1
    const pending = new Map<number, (m: Json) => void>()
    const write = (m: Json) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
    const call = (method: string, params: Json) =>
      new Promise<Json>(done => {
        const id = next++
        pending.set(id, done)
        write({ id, method, params })
      })
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const m = object(JSON.parse(line))
        if (typeof m.id === 'number' && m.method === undefined && pending.has(m.id)) {
          pending.get(m.id)!(m)
          pending.delete(m.id)
        }
      } catch {
        // not a reply
      }
    })
    void (async () => {
      await call('initialize', { clientInfo: { name: 'switchboard', version: '1' } })
      write({ method: 'initialized' })
      const plan = planTrust((await call('hooks/list', { cwds: [cwd] })).result, command)
      if (plan === null) return finish(false)
      if (plan === true) return finish(true)
      const wrote = await call('config/batchWrite', {
        edits: [{ keyPath: 'hooks.state', value: plan, mergeStrategy: 'upsert' }],
        filePath: null,
        expectedVersion: null,
        reloadUserConfig: true,
      })
      finish(object(wrote.result).status === 'ok')
    })().catch(() => finish(false))
  })
}
