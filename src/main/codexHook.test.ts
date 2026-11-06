import { describe, expect, test } from 'vitest'
import { CODEX_HOOK_EVENTS, planTrust } from './codexHook'

// As codex app-server 0.166 answered hooks/list for a -c hook.
const snake = (event: string) => event.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
const listed = (trustStatus: string, command = 'node /r/mcp/hook.mjs codex', events = CODEX_HOOK_EVENTS, trusted: string[] = []) => ({
  data: [
    {
      cwd: '/w',
      hooks: [
        { key: '/Users/p/.codex/hooks.json:permission_request:0:0', eventName: 'permissionRequest', source: 'user', command: 'guard', currentHash: 'sha256:u', trustStatus: 'trusted' },
        ...events.map(eventName => ({
          key: `/<session-flags>/config.toml:${snake(eventName)}:0:0`,
          eventName,
          source: 'sessionFlags',
          command,
          currentHash: `sha256:${eventName}`,
          trustStatus: trusted.includes(eventName) ? 'trusted' : trustStatus,
        })),
      ],
    },
  ],
})
const all = Object.fromEntries(CODEX_HOOK_EVENTS.map(e => [`/<session-flags>/config.toml:${snake(e)}:0:0`, { trusted_hash: `sha256:${e}` }]))

describe('planTrust', () => {
  test('writes the hashes Codex gave for Switchboard hooks, and only those', () => {
    expect(planTrust(listed('untrusted'), 'node /r/mcp/hook.mjs codex')).toEqual(all)
    expect(planTrust(listed('modified'), 'node /r/mcp/hook.mjs codex')).toEqual(all)
  })

  test('the permission hook trusted before the turn events: only the new ones', () => {
    const { ['/<session-flags>/config.toml:permission_request:0:0']: _kept, ...rest } = all
    expect(planTrust(listed('untrusted', undefined, undefined, ['permissionRequest']), 'node /r/mcp/hook.mjs codex')).toEqual(rest)
  })

  test('a Codex that lists one of them not: no hooks', () => {
    expect(planTrust(listed('untrusted', undefined, ['permissionRequest', 'stop']), 'node /r/mcp/hook.mjs codex')).toBeNull()
  })

  test('trusted already: nothing to write; not listed: no hook', () => {
    expect(planTrust(listed('trusted'), 'node /r/mcp/hook.mjs codex')).toBe(true)
    expect(planTrust(listed('untrusted', 'something else'), 'node /r/mcp/hook.mjs codex')).toBeNull()
    expect(planTrust({}, 'x')).toBeNull()
  })
})
