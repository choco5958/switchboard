import { describe, expect, it } from 'vitest'
import { agentChoices, matchesAgent } from './Dock'

const found = { found: { claude: '/usr/bin/claude', codex: '/usr/bin/codex', gemini: '/usr/bin/gemini', cursor: '/usr/bin/cursor-agent' } } as never
const custom = [{ id: 'x', name: 'Mine', command: 'mine', mcp: 'none' }]

describe('the agent picker', () => {
  it('offers only Claude Code when other agents are hidden', () => {
    expect(agentChoices(found, custom, false).map(c => c.kind)).toEqual(['claude'])
  })

  it('lists installed agents and the person\'s own, then the known ones not installed', () => {
    const choices = agentChoices(found, custom, true)
    const usable = choices.filter(c => c.installed).map(c => c.kind)
    expect(usable.slice(0, 3)).toEqual(['claude', 'codex', 'gemini'])
    expect(usable.at(-1)).toBe('x')
    const missing = choices.filter(c => !c.installed)
    expect(missing.length).toBeGreaterThan(0)
    expect(missing.every(c => c.blocked)).toBe(true)
    // Not installed ones come after every installed one.
    expect(choices.findIndex(c => !c.installed)).toBe(usable.length)
  })

  it('names how each one joins Switchboard', () => {
    const via = Object.fromEntries(agentChoices(found, custom, true).map(c => [c.kind, c.via]))
    expect(via.claude).toBe('mod')
    expect(via.codex).toBe('mcp')
    expect(via.x).toBe('plain')
  })

  it('puts the agent opened last first, unless it cannot open', () => {
    expect(agentChoices(found, custom, true, 'gemini')[0]!.kind).toBe('gemini')
    expect(agentChoices(found, custom, true, 'qwen')[0]!.kind).toBe('claude') // not installed here
    const noClaude = { found: { codex: '/usr/bin/codex' } } as never
    expect(agentChoices(noClaude, [], true, 'claude')[0]!.kind).toBe('claude') // blocked: stays where it is
    expect(agentChoices(noClaude, [], true, 'claude')[0]!.blocked).toBe(true)
  })

  it('shows nothing as missing before the look for installed CLIs is back', () => {
    expect(agentChoices(null, [], true).every(c => c.installed)).toBe(true)
  })

  it('filters by name or id, ignoring case and spaces', () => {
    expect(matchesAgent({ kind: 'claude', label: 'Claude Code' }, 'claudecode')).toBe(true)
    expect(matchesAgent({ kind: 'gemini', label: 'Gemini' }, 'GEM')).toBe(true)
    expect(matchesAgent({ kind: 'codex', label: 'Codex' }, 'gem')).toBe(false)
    expect(matchesAgent({ kind: 'codex', label: 'Codex' }, '')).toBe(true)
  })
})
