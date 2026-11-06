import { expect, test } from 'vitest'
import { focusScript, isLocalUrl, navigatedTo, pointScript, refRevision, refusal, snapshotText } from './agentBrowser'

test('only pages on this computer can be driven, the private network too when the person allows it', () => {
  const here = ['http://localhost:5173/', 'http://127.0.0.1:8951/x', 'https://app.localhost/', 'http://[::1]:4000', 'http://127.1.2.3']
  const lan = ['http://192.168.0.1', 'http://192.168.0.7:3000', 'http://10.1.2.3', 'http://172.20.0.2', 'http://mac.local:3000']
  const never = ['https://github.com', 'http://172.32.0.1', 'http://8.8.8.8', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']
  for (const url of here) expect([isLocalUrl(url), isLocalUrl(url, true)], url).toEqual([true, true])
  for (const url of lan) expect([isLocalUrl(url), isLocalUrl(url, true)], url).toEqual([false, true])
  for (const url of never) expect([isLocalUrl(url), isLocalUrl(url, true)], url).toEqual([false, false])
})

test('a ref names the reading it came from', () => {
  expect(refRevision('3:12')).toBe(3)
  expect(refRevision('12')).toBe(null)
})

test('a reading becomes lines the session can act on', () => {
  const text = snapshotText({
    url: 'http://localhost:5173/',
    title: '주문',
    elements: [
      { ref: '2:1', role: 'button', name: '저장' },
      { ref: '2:2', role: 'textbox', name: '' },
    ],
    text: '주문 목록\n3건',
    truncated: true,
  })
  expect(text).toBe('URL: http://localhost:5173/\nTitle: 주문\n\nElements (ref role "name"):\n[2:1] button "저장"\n[2:2] textbox\n\nText:\n주문 목록\n3건\n\n(truncated)')
})

test('a frame inside the page moving is not the page moving', () => {
  expect(navigatedTo({ url: 'http://localhost:5173/next' })).toBe('http://localhost:5173/next')
  expect(navigatedTo({ url: 'http://localhost:5173/#b', isMainFrame: true })).toBe('http://localhost:5173/#b')
  expect(navigatedTo({ url: 'http://localhost:6006/iframe.html#x', isMainFrame: false })).toBe(null)
})

// A page with one element of ref 1:1, for running the page scripts outside a browser.
type Fake = { rect?: { left: number; top: number; width: number; height: number }; disabled?: boolean; aria?: Record<string, string>; readOnly?: boolean; visibility?: string; top?: 'self' | 'other' | 'none' }
function runIn(script: string, fake: Fake): { x?: number; y?: number; error?: string; by?: string } {
  const rect = fake.rect ?? { left: 100, top: 200, width: 80, height: 30 }
  const el = {
    tagName: 'BUTTON',
    readOnly: fake.readOnly,
    matches: (selector: string) => selector === ':disabled' && fake.disabled === true,
    getAttribute: (name: string) => fake.aria?.[name] ?? null,
    scrollIntoView: () => {},
    focus: () => {},
    getBoundingClientRect: () => rect,
    contains: (other: unknown) => other === el,
  }
  const banner = { tagName: 'DIV', innerText: '쿠키 동의', getAttribute: () => null, contains: () => false }
  const document = {
    querySelector: (selector: string) => (selector === '[data-sb-ref="1:1"]' ? el : null),
    elementFromPoint: () => (fake.top === 'other' ? banner : fake.top === 'none' ? null : el),
  }
  const getComputedStyle = () => ({ visibility: fake.visibility ?? 'visible' })
  return new Function('document', 'getComputedStyle', 'innerWidth', 'innerHeight', `return ${script}`)(document, getComputedStyle, 1280, 800)
}

test('a press goes to the middle of an element that is still there, shown and enabled', () => {
  expect(runIn(pointScript('1:1'), {})).toEqual({ x: 140, y: 215 })
  expect(refusal(runIn(pointScript('1:1'), {}))).toBe(null)
})

test('a press on an element the page changed since the reading is refused with why', () => {
  // Hidden since: its box is empty, and a press at its corner would land on the page's top left.
  const cases: [Fake, string][] = [
    [{ rect: { left: 0, top: 0, width: 0, height: 0 } }, 'hidden'],
    [{ visibility: 'hidden' }, 'hidden'],
    [{ disabled: true }, 'disabled'],
    [{ aria: { 'aria-disabled': 'true' } }, 'disabled'],
    [{ rect: { left: 1500, top: 200, width: 80, height: 30 } }, 'outside'],
    [{ top: 'none' }, 'outside'],
    [{ top: 'other' }, 'covered'],
  ]
  for (const [fake, error] of cases) expect(runIn(pointScript('1:1'), fake).error, JSON.stringify(fake)).toBe(error)
  expect(runIn(pointScript('2:1'), {}).error).toBe('stale')
  expect(refusal(runIn(pointScript('1:1'), { top: 'other' }))).toBe('the element is covered by div "쿠키 동의"')
  expect(refusal(runIn(pointScript('1:1'), { disabled: true }))).toMatch(/disabled now/)
  expect(refusal(undefined)).toMatch(/gone/)
})

test('typing into a disabled or read-only field is refused instead of reported done', () => {
  expect(runIn(focusScript('1:1'), {})).toEqual({ ok: true })
  expect(runIn(focusScript('1:1'), { disabled: true }).error).toBe('disabled')
  expect(runIn(focusScript('1:1'), { readOnly: true }).error).toBe('readonly')
  expect(runIn(focusScript('1:1'), { aria: { 'aria-readonly': 'true' } }).error).toBe('readonly')
  expect(refusal(runIn(focusScript('1:1'), { readOnly: true }))).toBe('the field is read-only')
})
