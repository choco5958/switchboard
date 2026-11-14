import { expect, test } from 'vitest'
import { fileAskedScript, fillScript, isLocalUrl, navigatedTo, pointScript, refRevision, refusal, snapshotText } from './agentBrowser'

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

test('a reading says what each form control holds', () => {
  const text = snapshotText({
    url: 'http://localhost:5173/',
    title: '',
    elements: [
      { ref: '1:1', role: 'combobox', name: '크기', value: '보통', options: ['작게', '보통', '…'] },
      { ref: '1:2', role: 'textbox', name: '날짜', value: '2026-03-05' },
      { ref: '1:3', role: 'checkbox', name: '동의', checked: true },
      { ref: '1:4', role: 'radio', name: '', checked: false },
      { ref: '1:5', role: 'combobox', name: '', value: '', options: [] },
    ],
    text: '',
    truncated: false,
  })
  expect(text.split('\n').slice(4, 9)).toEqual([
    '[1:1] combobox "크기" = "보통" (options: "작게", "보통", …)',
    '[1:2] textbox "날짜" = "2026-03-05"',
    '[1:3] checkbox "동의" (checked)',
    '[1:4] radio (not checked)',
    '[1:5] combobox = "" (options: )',
  ])
})

test('a frame inside the page moving is not the page moving', () => {
  expect(navigatedTo({ url: 'http://localhost:5173/next' })).toBe('http://localhost:5173/next')
  expect(navigatedTo({ url: 'http://localhost:5173/#b', isMainFrame: true })).toBe('http://localhost:5173/#b')
  expect(navigatedTo({ url: 'http://localhost:6006/iframe.html#x', isMainFrame: false })).toBe(null)
})

// A page with one element of ref 1:1, for running the page scripts outside a browser.
type Option = { label: string; value: string; disabled?: boolean; selected?: boolean }
type Fake = {
  rect?: { left: number; top: number; width: number; height: number }
  disabled?: boolean
  aria?: Record<string, string>
  readOnly?: boolean
  visibility?: string
  top?: 'self' | 'other' | 'none'
  tag?: string
  type?: string
  value?: string
  options?: Option[]
  // What the field makes of a value set on it (a date field drops what is no date).
  keeps?: (value: string) => string
}
type Page = { window: { __sbFiles?: unknown }; clicks: ((event: unknown) => void)[]; events: string[]; selected: number; el: { value: string; options?: Option[] } }
function page(fake: Fake): Page & { run: (script: string) => { x?: number; y?: number; error?: string; by?: string; ok?: boolean; done?: boolean; type?: string; format?: string; options?: string[] } } {
  const rect = fake.rect ?? { left: 100, top: 200, width: 80, height: 30 }
  let value = fake.value ?? ''
  const state: Page = { window: {}, clicks: [], events: [], selected: 0, el: undefined as never }
  const el = {
    tagName: fake.tag ?? 'BUTTON',
    type: fake.type ?? '',
    readOnly: fake.readOnly,
    options: fake.options,
    get value() {
      return value
    },
    set value(next: string) {
      value = fake.keeps ? fake.keeps(next) : next
    },
    matches: (selector: string) => selector === ':disabled' && fake.disabled === true,
    getAttribute: (name: string) => fake.aria?.[name] ?? null,
    scrollIntoView: () => {},
    focus: () => {},
    select: () => {
      state.selected += 1
    },
    dispatchEvent: (event: { type: string }) => state.events.push(event.type),
    getBoundingClientRect: () => rect,
    contains: (other: unknown) => other === el,
  }
  state.el = el
  const banner = { tagName: 'DIV', innerText: '쿠키 동의', getAttribute: () => null, contains: () => false }
  const document = {
    querySelector: (selector: string) => (selector === '[data-sb-ref="1:1"]' ? el : null),
    elementFromPoint: () => (fake.top === 'other' ? banner : fake.top === 'none' ? null : el),
  }
  const getComputedStyle = () => ({ visibility: fake.visibility ?? 'visible' })
  const addEventListener = (name: string, listener: (event: unknown) => void) => {
    if (name === 'click') state.clicks.push(listener)
  }
  class Event {
    type: string
    constructor(type: string) {
      this.type = type
    }
  }
  const run = (script: string) =>
    new Function('document', 'getComputedStyle', 'innerWidth', 'innerHeight', 'window', 'addEventListener', 'Event', `return ${script}`)(document, getComputedStyle, 1280, 800, state.window, addEventListener, Event)
  return Object.assign(state, { run })
}
const runIn = (script: string, fake: Fake) => page(fake).run(script)

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
  const field = page({ tag: 'INPUT', type: 'text' })
  expect(field.run(fillScript('1:1', '글'))).toEqual({ ok: true })
  // What the field held is selected, so the typing that follows replaces it.
  expect(field.selected).toBe(1)
  expect(runIn(fillScript('1:1', '글'), { disabled: true }).error).toBe('disabled')
  expect(runIn(fillScript('1:1', '글'), { readOnly: true }).error).toBe('readonly')
  expect(runIn(fillScript('1:1', '글'), { aria: { 'aria-readonly': 'true' } }).error).toBe('readonly')
  expect(refusal(runIn(fillScript('1:1', '글'), { readOnly: true }))).toBe('the field is read-only')
  expect(runIn(fillScript('2:1', '글'), {}).error).toBe('stale')
})

const sizes = (): Option[] => [
  { label: '고르세요', value: '' },
  { label: '작게', value: 's' },
  { label: 'Medium  size', value: 'm' },
  { label: '크게', value: 'l', disabled: true },
]

test('a select takes the option of that name instead of typed text', () => {
  // By name, by value, by name in another case: the page hears it as a person's change.
  for (const [text, index] of [['작게', 1], ['m', 2], ['medium size', 2], [' 작게 ', 1]] as const) {
    const options = sizes()
    const select = page({ tag: 'SELECT', options })
    expect(select.run(fillScript('1:1', text)), text).toEqual({ done: true })
    expect(options.findIndex(o => o.selected), text).toBe(index)
    expect(select.events).toEqual(['input', 'change'])
  }
})

test('a select without that option, or with it disabled, is refused with the options it has', () => {
  for (const text of ['아주 크게', '크게', 'x']) {
    const options = sizes()
    const select = page({ tag: 'SELECT', options })
    const result = select.run(fillScript('1:1', text))
    expect(result).toEqual({ error: 'option', options: ['고르세요', '작게', 'Medium size'] })
    expect(options.some(o => o.selected)).toBe(false)
    expect(select.events).toEqual([])
    expect(refusal(result)).toBe('the select has no such option; its options are: "고르세요", "작게", "Medium size"')
  }
})

test('a date, a color and a slider take their value whole, in the form the field keeps', () => {
  const date = page({ tag: 'INPUT', type: 'date', value: '2026-01-01', keeps: v => (/^\d{4}-\d\d-\d\d$/.test(v) ? v : '') })
  expect(date.run(fillScript('1:1', ' 2026-03-05 '))).toEqual({ done: true })
  expect(date.el.value).toBe('2026-03-05')
  expect(date.events).toEqual(['input', 'change'])
  // Nothing is typed into it, so nothing is selected first.
  expect(date.selected).toBe(0)

  const color = page({ tag: 'INPUT', type: 'color', value: '#000000', keeps: v => v.toLowerCase() })
  expect(color.run(fillScript('1:1', '#FF0000'))).toEqual({ done: true })
  expect(color.el.value).toBe('#ff0000')

  const slider = page({ tag: 'INPUT', type: 'range', value: '3', keeps: v => String(Math.min(10, Math.max(0, Number(v) || 0))) })
  expect(slider.run(fillScript('1:1', '7.0'))).toEqual({ done: true })
  expect(slider.el.value).toBe('7')
})

test('a value the field cannot hold leaves it as it was and says the form it takes', () => {
  const date = page({ tag: 'INPUT', type: 'date', value: '2026-01-01', keeps: v => (/^\d{4}-\d\d-\d\d$/.test(v) ? v : '') })
  const result = date.run(fillScript('1:1', '3월 5일'))
  expect(result).toEqual({ error: 'value', type: 'date', format: 'YYYY-MM-DD' })
  expect(date.el.value).toBe('2026-01-01')
  expect(date.events).toEqual([])
  expect(refusal(result)).toBe('a date field takes YYYY-MM-DD')

  // Past the slider's end the browser bends the number to the end.
  const slider = page({ tag: 'INPUT', type: 'range', value: '3', keeps: v => String(Math.min(10, Math.max(0, Number(v) || 0))) })
  expect(slider.run(fillScript('1:1', '37')).error).toBe('value')
  expect(slider.el.value).toBe('3')
  expect(slider.run(fillScript('1:1', '')).error).toBe('value')
})

test('a checkbox and a file field take no text', () => {
  const box = page({ tag: 'INPUT', type: 'checkbox', value: 'on' })
  expect(refusal(box.run(fillScript('1:1', 'x')))).toBe('a checkbox takes no text; press it with browser_click')
  expect(box.el.value).toBe('on')
  expect(refusal(runIn(fillScript('1:1', '/etc/passwd'), { tag: 'INPUT', type: 'file' }))).toMatch(/cannot choose a file/)
})

// A click as the page hears it, on a field of that type.
const clickOn = (type: string) => {
  const event = { target: { tagName: 'INPUT', type }, prevented: false, preventDefault: () => void (event.prevented = true) }
  return event
}

test('a press that makes the page ask for a file opens no file dialog, and says so', () => {
  const view = page({})
  expect(view.run(fileAskedScript())).toBe(false)
  expect(view.run(pointScript('1:1'))).toEqual({ x: 140, y: 215 })
  expect(view.clicks.length).toBe(1)
  // The press reached a file field (itself, or through the page's own script).
  const file = clickOn('file')
  view.clicks[0]!(file)
  expect(file.prevented).toBe(true)
  // Anything else goes through.
  const box = clickOn('checkbox')
  view.clicks[0]!(box)
  expect(box.prevented).toBe(false)
  expect(view.run(fileAskedScript())).toBe(true)
  expect(view.run(fileAskedScript())).toBe(false)
})

test('the person’s own press on a file field opens the dialog as ever', () => {
  const view = page({})
  view.run(pointScript('1:1'))
  view.run(fileAskedScript())
  const file = clickOn('file')
  view.clicks[0]!(file)
  expect(file.prevented).toBe(false)
  // The next press listens once more, not twice.
  view.run(pointScript('1:1'))
  expect(view.clicks.length).toBe(1)
  const again = clickOn('file')
  view.clicks[0]!(again)
  expect(again.prevented).toBe(true)
  // A press that asked for no file says nothing.
  view.run(pointScript('1:1'))
  expect(view.run(fileAskedScript())).toBe(false)
})
