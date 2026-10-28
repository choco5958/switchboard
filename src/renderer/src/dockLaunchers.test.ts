import { describe, expect, it } from 'vitest'
import { launchers } from './Dock'

const found = { found: { codex: '/usr/bin/codex', gemini: '/usr/bin/gemini' } } as never
const custom = [{ id: 'x', name: 'Mine', command: 'mine', mcp: 'none' }]

describe('dock launchers', () => {
  it('offers only Claude and shell when other agents are hidden', () => {
    expect(launchers(found, custom, false).map(l => l.kind)).toEqual(['claude', 'shell'])
  })
  it('adds installed agents and custom ones when shown', () => {
    expect(launchers(found, custom, true).map(l => l.kind)).toEqual(['claude', 'shell', 'codex', 'gemini', 'x'])
  })
})
