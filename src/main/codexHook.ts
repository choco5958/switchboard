// Codex runs a hook only once its exact definition is recorded as trusted (hooks.state in
// ~/.codex/config.toml, keyed by where the hook came from and hashed by Codex). With the relay
// turned on (agents.ts CODEX_APPROVALS_KEY), the app has Codex itself record Switchboard's
// permission hook before it opens a Codex terminal: `codex app-server` with the same -c value
// lists the hook with its hash (hooks/list) and writes the trust (config/batchWrite), as Codex's
// own /hooks review does. Nothing else in the file changes, and no hook runs untrusted
// (--dangerously-bypass-hook-trust would let every hook of the run do so).
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

type Json = Record<string, unknown>
const object = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})

// From the hooks/list reply: true when Switchboard's hook is trusted already, the hooks.state
// value to write when it is not, null when the list does not hold it (Codex changed, or the
// relay cannot be set up: the terminal then opens without the hook).
export function planTrust(list: unknown, command: string): true | Json | null {
  const data = object(list).data
  const hooks = Array.isArray(data) ? data.flatMap(entry => (Array.isArray(object(entry).hooks) ? (object(entry).hooks as unknown[]) : [])) : []
  const mine = hooks.map(object).find(h => h.source === 'sessionFlags' && h.eventName === 'permissionRequest' && h.command === command)
  if (!mine || typeof mine.key !== 'string' || typeof mine.currentHash !== 'string') return null
  if (mine.trustStatus === 'trusted') return true
  return { [mine.key]: { trusted_hash: mine.currentHash } }
}

// `codex`: how to start it (agentDetect.ts cliBins: an npm-installed one runs with node).
export function trustCodexHook(codex: string[], override: string, command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const child = spawn(codex[0]!, [...codex.slice(1), 'app-server', '-c', override], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
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
