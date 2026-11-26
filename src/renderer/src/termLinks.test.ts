import { describe, expect, it } from 'vitest'
import { setLang } from '../../shared/i18n'
import { LINK_PATTERN, linkHint, linkKeyHeld, linkTarget } from './termLinks'

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

describe('LINK_PATTERN', () => {
  const found = (line: string) => [...line.matchAll(new RegExp(LINK_PATTERN.source, 'g'))].map(m => m[0])

  it('ends an address where a word of the sentence follows it with no space', () => {
    expect(found('개발 서버가 http://localhost:5173에서 실행 중입니다.')).toEqual(['http://localhost:5173'])
    expect(found('브라우저에서 http://localhost:3000/login으로 이동하세요')).toEqual(['http://localhost:3000/login'])
    expect(found('サーバーはhttp://localhost:3000で起動しています。')).toEqual(['http://localhost:3000'])
    expect(found('请访问http://localhost:8080/admin查看，或者https://example.com。')).toEqual(['http://localhost:8080/admin', 'https://example.com'])
    expect(found('│ http://127.0.0.1:4000/│ http://localhost:9/a✅')).toEqual(['http://127.0.0.1:4000/', 'http://localhost:9/a'])
    for (const address of found('http://localhost:5173에서 https://example.com/docs를')) expect(linkTarget(address), address).not.toBeNull()
  })

  it('keeps letters outside ASCII that start a part of the address', () => {
    expect(found('see https://ko.wikipedia.org/wiki/한글 and https://example.com/search?q=가나다&x=1 end')).toEqual(['https://ko.wikipedia.org/wiki/한글', 'https://example.com/search?q=가나다&x=1'])
    expect(found('https://example.com/문서/시작하기#설치。')).toEqual(['https://example.com/문서/시작하기#설치'])
  })

  it('reads an ASCII address as xterm does', () => {
    expect(found('plain http://localhost:5173/app?x=1, then (https://github.com/a/b/pull/1).')).toEqual(['http://localhost:5173/app?x=1', 'https://github.com/a/b/pull/1'])
    expect(found('http://[::1]:3000/ HTTPS://EXAMPLE.COM/A_b-c~d/ http://user:pw@host:8080/x;y=1!')).toEqual(['http://[::1]:3000/', 'HTTPS://EXAMPLE.COM/A_b-c~d/', 'http://user:pw@host:8080/x;y=1'])
    expect(found('http:// https://. ftp://example.com')).toEqual([])
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
