import { expect, test } from 'vitest'
import { CANCEL_PREFIX, CaptureLimiter, EXIT_PREFIX, PICK_PREFIX, SAVE_PREFIX, TOGGLE_PREFIX, crumbsOf, makeNonce, parseMessage, pickerSource, type CrumbNode } from './picker'
import { setLang } from '../../shared/i18n'

const node = (tag: string, over: Partial<CrumbNode> = {}): CrumbNode => ({ tag, role: '', type: '', label: '', heading: '', cls: '', text: '', ...over })

test('landmarks, named sections and the element with its kind', () => {
  const chain = [node('span', { cls: 'badge badge-muted', text: '미시작' }), node('div', { cls: 'row' }), node('section', { heading: '현황판' }), node('main')]
  expect(crumbsOf(chain)).toEqual(['본문', '현황판 쪽', '"미시작" 꼬리표'])
})

test('labels name places; unnamed sections and plain divs are skipped', () => {
  const chain = [node('button', { text: '저장' }), node('form', { label: '회원 정보' }), node('section'), node('div'), node('nav', { label: '주' })]
  expect(crumbsOf(chain)).toEqual(['주 탐색', '회원 정보 양식', '"저장" 버튼'])
})

test('roles count like tags, and an element label wins over its text', () => {
  const chain = [node('div', { role: 'button', label: '닫기', text: 'x' }), node('div', { role: 'dialog', label: '설정' })]
  expect(crumbsOf(chain)).toEqual(['설정 대화 상자', '"닫기" 버튼'])
})

test('kinds of common elements', () => {
  const kind = (n: CrumbNode) => crumbsOf([n])[0]
  expect(kind(node('a', { text: '홈' }))).toBe('"홈" 링크')
  expect(kind(node('input', { type: 'text', label: '이름' }))).toBe('"이름" 입력칸')
  expect(kind(node('input', { type: 'checkbox' }))).toBe('체크 상자')
  expect(kind(node('h2', { text: '요약' }))).toBe('"요약" 제목')
  expect(kind(node('img'))).toBe('그림')
  expect(kind(node('td', { text: '3' }))).toBe('"3" 표 칸')
  expect(kind(node('div'))).toBe('요소')
})

test('long names are cut, whitespace collapsed, and deep chains keep the outermost and nearest two', () => {
  const chain = [
    node('p', { text: '아주   긴 문장이 여기에 길게 이어지고 또 이어집니다' }),
    node('section', { heading: '넷' }),
    node('section', { heading: '셋' }),
    node('article', { heading: '둘' }),
    node('main'),
  ]
  const crumbs = crumbsOf(chain)
  expect(crumbs).toEqual(['본문', '셋 쪽', '넷 쪽', '"아주 긴 문장이 여기에 길게 이어지고 또…" 문단'])
})

test('repeated places collapse and an empty chain gives nothing', () => {
  expect(crumbsOf([node('span', { text: 'a' }), node('main'), node('div', { role: 'main' })])).toEqual(['본문', '"a" 글자'])
  expect(crumbsOf([])).toEqual([])
})

test('the injected source is valid JavaScript and carries the breadcrumb function and the nonce', () => {
  const source = pickerSource('abc123')
  expect(() => new Function(source)).not.toThrow()
  expect(source).toContain('const crumbsIn = (')
  expect(source).toContain('무엇을 바꾸면 좋을지 적으세요')
  expect(source).toContain('"abc123"')
  expect(source).not.toContain('console.log(')
})

test('a nonce is 32 hex characters and new each time', () => {
  const a = makeNonce()
  expect(a).toMatch(/^[0-9a-f]{32}$/)
  expect(makeNonce()).not.toBe(a)
})

test('only messages with this injection\'s nonce count', () => {
  const n = 'n0nce'
  const pick = { id: 1, selector: 'main > p', tag: 'p', text: '글', url: 'http://a/', rect: { x: 1, y: 2, width: 3, height: 4 }, crumbs: ['본문'] }
  expect(parseMessage(PICK_PREFIX + n + ':' + JSON.stringify(pick), n)).toEqual({ kind: 'pick', pick })
  expect(parseMessage(SAVE_PREFIX + n + ':' + JSON.stringify({ id: 1, memo: ' 굵게 ' }), n)).toEqual({ kind: 'save', id: 1, memo: '굵게' })
  expect(parseMessage(CANCEL_PREFIX + n + ':{"id":2}', n)).toEqual({ kind: 'cancel', id: 2 })
  expect(parseMessage(EXIT_PREFIX + n, n)).toEqual({ kind: 'exit' })
  expect(parseMessage(TOGGLE_PREFIX + n, n)).toEqual({ kind: 'toggle' })
  // What a page could log on its own: the bare prefixes, or another nonce.
  expect(parseMessage(PICK_PREFIX + JSON.stringify(pick), n)).toBeNull()
  expect(parseMessage(TOGGLE_PREFIX, n)).toBeNull()
  expect(parseMessage(EXIT_PREFIX + 'other', n)).toBeNull()
  expect(parseMessage(SAVE_PREFIX + 'other:' + JSON.stringify({ id: 1, memo: 'x' }), n)).toBeNull()
  expect(parseMessage(TOGGLE_PREFIX, '')).toBeNull()
  // Broken shapes are dropped too.
  expect(parseMessage(SAVE_PREFIX + n + ':{"id":1,"memo":"  "}', n)).toBeNull()
  expect(parseMessage(PICK_PREFIX + n + ':{"id":"x"}', n)).toBeNull()
  expect(parseMessage(PICK_PREFIX + n + ':not json', n)).toBeNull()
})

test('captures: one per gap and a fixed number per page load', () => {
  const limit = new CaptureLimiter(500, 3)
  expect(limit.allow(0)).toBe(true)
  expect(limit.allow(100)).toBe(false)
  expect(limit.allow(600)).toBe(true)
  expect(limit.allow(1200)).toBe(true)
  expect(limit.allow(5000)).toBe(false)
  limit.reset()
  expect(limit.allow(5000)).toBe(true)
})

// Feature area: UI language. Breadcrumbs and the popover go into the page in the chosen language.
test('breadcrumbs and the popover follow the UI language', () => {
  setLang('en')
  try {
    const chain = [node('span', { cls: 'badge', text: 'Pending' }), node('section', { heading: 'Overview' }), node('main')]
    expect(crumbsOf(chain)).toEqual(['Main', 'Overview section', '"Pending" tag'])
    expect(crumbsOf([node('button', { text: 'Save' }), node('form', { label: 'Profile' })])).toEqual(['Profile Form', '"Save" button'])
    const source = pickerSource('n1')
    expect(() => new Function(source)).not.toThrow()
    expect(source).toContain('What should change here?')
    setLang('ja')
    expect(crumbsOf([node('button', { text: '保存' }), node('div', { role: 'dialog', label: '設定' })])).toEqual(['設定ダイアログ', '「保存」ボタン'])
  } finally {
    setLang('ko')
  }
})
