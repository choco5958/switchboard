import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { accountOf, configPath, hasYearToken, maskEmail, planLabel, readAccount, readAccountInfo, readCcr, readCcrSlot, refreshDaysLeft, refreshExpiry } from './account'

describe('account', () => {
  test('masks the email', () => {
    expect(maskEmail('jane.doe@example.com')).toBe('ja****@example.com')
    expect(maskEmail('a@b.c')).toBe('a****@b.c')
    expect(maskEmail('nope')).toBe('')
  })
  test('readable plan labels', () => {
    expect(planLabel('default_claude_max_20x')).toBe('Claude Max 20x')
    expect(planLabel('claude_pro')).toBe('Claude Pro')
  })
  test('tier order: user, organization, type, seat', () => {
    expect(accountOf({ oauthAccount: { emailAddress: 'xy@z.kr', userRateLimitTier: null, organizationRateLimitTier: 'default_claude_max_5x', organizationType: 'claude_max' } })).toEqual({
      email: 'xy****@z.kr',
      plan: 'Claude Max 5x',
    })
    expect(accountOf({ oauthAccount: { emailAddress: 'xy@z.kr', organizationType: 'claude_team' } })?.plan).toBe('Claude Team')
    expect(accountOf({})).toBeNull()
  })
  test('reads $CLAUDE_CONFIG_DIR/.claude.json first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acct-'))
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@x.kr', seatTier: 'premium' } }))
    expect(configPath({ CLAUDE_CONFIG_DIR: dir })).toBe(join(dir, '.claude.json'))
    expect(readAccount(join(dir, '.claude.json'))).toEqual({ email: 'me****@x.kr', plan: 'Premium' })
    expect(readAccount(join(dir, 'missing.json'))).toBeNull()
  })
})

describe('ccr slots', () => {
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), 'ccr-home-'))
    const root = join(home, '.claude-acct')
    mkdirSync(join(root, 'state'), { recursive: true })
    mkdirSync(join(root, '2'))
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'one@x.kr', userRateLimitTier: 'default_claude_max_20x' } }))
    writeFileSync(join(root, '2', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'two@x.kr' } }))
    return { home, root, count: 3 }
  }

  test('no ccr state: falls back to the plain account', () => {
    const paths = setup()
    expect(readCcr(paths)).toBeUndefined()
  })

  test('reads every slot, the current one, limits and measured usage', () => {
    const paths = setup()
    writeFileSync(join(paths.root, 'state', 'current'), '2\n')
    writeFileSync(join(paths.root, 'state', 'until-1'), '1793102460\n')
    writeFileSync(join(paths.root, 'state', 'until-2'), 'garbage')
    writeFileSync(
      join(paths.root, 'state', 'usage-2.json'),
      JSON.stringify({ at: 1793000000, ok: true, data: { five_hour: { utilization: 21.4 }, seven_day: { utilization: 99.6, resets_at: '2026-11-01T19:00:00+00:00' } } }),
    )
    const info = readAccountInfo(paths, 1793000000_000 + 60_000)
    expect(info?.email).toBe('tw****@x.kr')
    expect(info?.ccr?.current).toBe(2)
    expect(info?.ccr?.slots.map(s => [s.slot, s.email, s.until])).toEqual([
      [1, 'on****@x.kr', 1793102460],
      [2, 'tw****@x.kr', 0],
      [3, '', 0],
    ])
    expect(info?.ccr?.slots[1]).toMatchObject({ fiveHour: 21, week: 100, weekResetsAt: '2026-11-01T19:00:00+00:00', measuredAt: 1793000000 })
    expect(info?.ccr?.slots[0]?.fiveHour).toBeUndefined()
  })

  test('a failed measurement keeps the last good data, dated when it was good', () => {
    const paths = setup()
    writeFileSync(join(paths.root, 'state', 'current'), '1')
    writeFileSync(
      join(paths.root, 'state', 'usage-1.json'),
      JSON.stringify({ at: 1793100000, ok: false, err: 'http 401 token expired', data_at: 1793000000, data: { five_hour: { utilization: 40, resets_at: null } } }),
    )
    const one = readCcr(paths, 1793100000_000)?.slots[0]
    expect(one?.measuredAt).toBe(1793000000)
    expect(one?.measureError).toBe('http 401 token expired')
    expect(one?.fiveHour).toBeUndefined() // good data from more than five hours before
  })

  test('usage from before the window reset is left out', () => {
    const paths = setup()
    writeFileSync(join(paths.root, 'state', 'current'), '1')
    writeFileSync(
      join(paths.root, 'state', 'usage-1.json'),
      JSON.stringify({ at: 1793000000, ok: true, data: { five_hour: { utilization: 40, resets_at: null }, seven_day: { utilization: 100, resets_at: '2026-10-26T02:00:00+00:00' } } }),
    )
    const soon = readCcr(paths, 1793000000_000 + 3600_000)?.slots[0]
    expect(soon).toMatchObject({ fiveHour: 40, week: undefined }) // the week had already reset before the measurement was read
    const later = readCcr(paths, 1793000000_000 + 6 * 3600_000)?.slots[0]
    expect(later?.fiveHour).toBeUndefined() // no reset time: trusted for one five-hour window
  })

  test('the slot files never reach the token fields', () => {
    const paths = setup()
    writeFileSync(join(paths.root, 'state', 'current'), '1')
    const planted = `planted-${Math.random().toString(36).slice(2)}`
    writeFileSync(join(paths.home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'one@x.kr', accountUuid: planted }, userID: planted }))
    expect(JSON.stringify(readAccountInfo(paths))).not.toContain(planted)
  })
})

describe('refresh token expiry', () => {
  const now = 1_793_164_293_000

  test('counts whole days down and goes negative once expired', () => {
    expect(refreshDaysLeft(now + 1.4 * 86400_000, now)).toBe(1)
    expect(refreshDaysLeft(now + 3 * 86400_000, now)).toBe(3)
    expect(refreshDaysLeft(now + 3 * 86400_000 - 1, now)).toBe(2)
    expect(refreshDaysLeft(now + 3600_000, now)).toBe(0)
    expect(refreshDaysLeft(now - 1, now)).toBe(-1)
  })

  test('only epoch milliseconds are accepted', () => {
    expect(refreshExpiry(1_793_287_676_492)).toBe(1_793_287_676_492)
    expect(refreshExpiry(1_793_287_676)).toBeUndefined()
    expect(refreshExpiry('1793287676492')).toBeUndefined()
    expect(refreshExpiry(undefined)).toBeUndefined()
  })

  test('a slot takes the expiry from usage cred and nothing else from it', () => {
    const root = mkdtempSync(join(tmpdir(), 'ccr-'))
    mkdirSync(join(root, 'state'))
    writeFileSync(join(root, 'state', 'usage-2.json'), JSON.stringify({ ok: true, at: 1, cred: { expiresAt: 5, refreshTokenExpiresAt: 1_795_622_217_821, accessToken: 'SECRET' } }))
    const slot = readCcrSlot({ root, home: root, count: 4 }, 2)
    expect(slot.refreshExpiresAt).toBe(1_795_622_217_821)
    expect(JSON.stringify(slot)).not.toContain('SECRET')
    expect(readCcrSlot({ root, home: root, count: 4 }, 3).refreshExpiresAt).toBeUndefined()
  })

  test('the year token check reads an exit code only: an unknown service is false', async () => {
    expect(await hasYearToken(9, { CCR_TOKEN_SERVICE: 'ccr-oauth-nonexistent-test' })).toBe(false)
  })
})
