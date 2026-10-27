import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { accountOf, configPath, maskEmail, planLabel, readAccount } from './account'

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
