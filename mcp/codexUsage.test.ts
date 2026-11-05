import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexArgv, rateLimitsOf } from './codexUsage.ts'

test('Codex rate limits become the bridge usage windows', () => {
  // As codex app-server 0.166 answered account/rateLimits/read.
  const reply = {
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: 1794203625 },
      secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1793880000 },
      planType: 'pro',
    },
  }
  assert.deepEqual(rateLimitsOf(reply), [
    { kind: 'seven_day', percentUsed: 99, resetsAt: new Date(1794203625 * 1000).toISOString() },
    { kind: 'five_hour', percentUsed: 12, resetsAt: new Date(1793880000 * 1000).toISOString() },
  ])
  assert.deepEqual(rateLimitsOf({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 60 }, secondary: null } }), [])
  assert.deepEqual(rateLimitsOf(null), [])
})

test('an npm codex runs with this Node, a native one as it is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-codex-'))
  const script = join(dir, 'codex.js')
  const native = join(dir, 'codex')
  writeFileSync(script, '#!/usr/bin/env node\n')
  writeFileSync(native, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]))
  assert.deepEqual(codexArgv(script, '/n/node'), ['/n/node', script])
  assert.deepEqual(codexArgv(native, '/n/node'), [native])
  assert.deepEqual(codexArgv(join(dir, 'none')), [])
  rmSync(dir, { recursive: true, force: true })
})
