import { describe, expect, it } from 'vitest'
import { setLang } from '../../shared/i18n'
import { linkHint, linkKeyHeld, linkTarget } from './termLinks'

describe('linkTarget', () => {
  it('sends an address on this computer to the in-app browser and any other to the person’s browser', () => {
    expect(linkTarget('http://localhost:5173/app?x=1')).toEqual({ url: 'http://localhost:5173/app?x=1', local: true })
    expect(linkTarget('http://127.0.0.1:8080')).toEqual({ url: 'http://127.0.0.1:8080/', local: true })
    expect(linkTarget('https://github.com/choco5958/switchboard/pull/1')).toEqual({ url: 'https://github.com/choco5958/switchboard/pull/1', local: false })
    expect(linkTarget('http://192.168.0.7:3000/')).toEqual({ url: 'http://192.168.0.7:3000/', local: false })
  })

  it('opens nothing but a web address', () => {
    for (const raw of ['file:///etc/hosts', 'javascript:alert(1)', 'vscode://file/x', 'mailto:a@example.com', '-a Calculator', 'README.md', '']) expect(linkTarget(raw), raw).toBeNull()
  })
})

describe('linkKeyHeld', () => {
  it('takes ⌘ on macOS and Ctrl elsewhere, and no press without the key', () => {
    expect(linkKeyHeld({ metaKey: true, ctrlKey: false }, true)).toBe(true)
    expect(linkKeyHeld({ metaKey: false, ctrlKey: true }, true)).toBe(false)
    expect(linkKeyHeld({ metaKey: false, ctrlKey: true }, false)).toBe(true)
    expect(linkKeyHeld({ metaKey: true, ctrlKey: false }, false)).toBe(false)
    expect(linkKeyHeld({ metaKey: false, ctrlKey: false }, true)).toBe(false)
  })
})

describe('linkHint', () => {
  it('names the key, and shows where a link the program named leads', () => {
    setLang('en')
    expect(linkHint(true)).toBe('Hold ⌘ and click to open')
    expect(linkHint(false)).toBe('Hold Ctrl and click to open')
    expect(linkHint(false, 'https://example.com/real')).toBe('https://example.com/real\nHold Ctrl and click to open')
    setLang('ko')
  })
})
