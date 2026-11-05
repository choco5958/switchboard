import { describe, expect, test } from 'vitest'
import { planTrust } from './codexHook'

// As codex app-server 0.166 answered hooks/list for a -c hook.
const listed = (trustStatus: string, command = 'node /r/mcp/hook.mjs codex') => ({
  data: [
    {
      cwd: '/w',
      hooks: [
        { key: '/Users/p/.codex/hooks.json:permission_request:0:0', eventName: 'permissionRequest', source: 'user', command: 'guard', currentHash: 'sha256:u', trustStatus: 'trusted' },
        { key: '/<session-flags>/config.toml:permission_request:0:0', eventName: 'permissionRequest', source: 'sessionFlags', command, currentHash: 'sha256:m', trustStatus },
      ],
    },
  ],
})

describe('planTrust', () => {
  test('writes the hash Codex gave for Switchboard hook, and only that', () => {
    expect(planTrust(listed('untrusted'), 'node /r/mcp/hook.mjs codex')).toEqual({ '/<session-flags>/config.toml:permission_request:0:0': { trusted_hash: 'sha256:m' } })
    expect(planTrust(listed('modified'), 'node /r/mcp/hook.mjs codex')).toEqual({ '/<session-flags>/config.toml:permission_request:0:0': { trusted_hash: 'sha256:m' } })
  })

  test('trusted already: nothing to write; not listed: no hook', () => {
    expect(planTrust(listed('trusted'), 'node /r/mcp/hook.mjs codex')).toBe(true)
    expect(planTrust(listed('untrusted', 'something else'), 'node /r/mcp/hook.mjs codex')).toBeNull()
    expect(planTrust({}, 'x')).toBeNull()
  })
})
