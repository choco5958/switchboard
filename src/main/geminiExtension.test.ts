import { describe, expect, test } from 'vitest'
import { installRecord, linkState } from './geminiExtension'

describe('the Gemini extension link', () => {
  test('ours only when Gemini recorded a link to the app folder', () => {
    // As gemini extensions link 0.67 wrote it.
    expect(linkState(JSON.stringify({ source: '/h/.claude-ide/agents/gemini-extension', type: 'link' }), '/h/.claude-ide/agents/gemini-extension')).toBe('ours')
    expect(linkState(JSON.stringify({ source: '/elsewhere', type: 'link' }), '/h/.claude-ide/agents/gemini-extension')).toBe('other')
    expect(linkState(JSON.stringify({ source: 'https://github.com/x/switchboard', type: 'git' }), '/h/x')).toBe('other')
    expect(linkState('not json', '/h/x')).toBe('other')
    expect(linkState(null, '/h/x')).toBe('none')
  })

  test('the record sits under GEMINI_CLI_HOME when set, else HOME', () => {
    expect(installRecord({ HOME: '/h' })).toBe('/h/.gemini/extensions/switchboard/.gemini-extension-install.json')
    expect(installRecord({ HOME: '/h', GEMINI_CLI_HOME: '/g' })).toBe('/g/.gemini/extensions/switchboard/.gemini-extension-install.json')
  })
})
