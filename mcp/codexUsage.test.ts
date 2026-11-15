import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexArgv, rateLimitsOf } from './codexUsage.ts'
import { limitedUntil } from '../src/shared/limit.ts'

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

test("a seat's spending cap is a window of its own, also when it is the only one", () => {
  // RateLimitSnapshot.individualLimit of codex app-server (SpendControlLimitSnapshot): a workspace
  // member's seat with no five-hour or weekly window.
  const resetsAt = new Date(1800000000 * 1000).toISOString()
  const only = { rateLimits: { primary: null, secondary: null, individualLimit: { limit: '50', used: '10', remainingPercent: 80, resetsAt: 1800000000 }, spendControlReached: false } }
  assert.deepEqual(rateLimitsOf(only), [{ kind: 'spend', percentUsed: 20, resetsAt }])
  const both = { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1793880000 }, secondary: null, individualLimit: { remainingPercent: 0.5, resetsAt: 1800000000 } } }
  assert.deepEqual(rateLimitsOf(both).map(l => [l.kind, l.percentUsed]), [['five_hour', 12], ['spend', 99.5]])
  // Reached, whatever share is said to be left; a share out of range stays within 0 and 100.
  assert.equal(rateLimitsOf({ rateLimits: { individualLimit: { remainingPercent: 3, resetsAt: 1800000000 }, spendControlReached: true } })[0]!.percentUsed, 100)
  assert.equal(rateLimitsOf({ rateLimits: { individualLimit: { remainingPercent: 140 } } })[0]!.percentUsed, 0)
  assert.deepEqual(rateLimitsOf({ rateLimits: { individualLimit: { remainingPercent: -5 } } }), [{ kind: 'spend', percentUsed: 100 }])
  // No cap, or one that says nothing of what is left: no window.
  for (const individualLimit of [null, {}, { remainingPercent: null }, { remainingPercent: 'x' }]) assert.deepEqual(rateLimitsOf({ rateLimits: { individualLimit } }), [])
  // A session at its cap is held until the cap resets, as one at a five-hour limit is.
  const reached = JSON.stringify({ rateLimits: rateLimitsOf({ rateLimits: { individualLimit: { remainingPercent: 0, resetsAt: 1800000000 } } }) })
  assert.equal(limitedUntil(reached, 1799990000_000, 1799990000_000), 1800000000_000 + 30_000)
  assert.equal(limitedUntil(JSON.stringify({ rateLimits: rateLimitsOf(only) }), 1799990000_000, 1799990000_000), null)
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
