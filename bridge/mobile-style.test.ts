// The phone page's colours and sizes (bridge/mobile/style.css): every text it draws reads at
// 4.5:1 or more against what it sits on, every control border and mark at 3:1, in the dark and
// the light theme; the dark tokens it shares with the desktop default theme are the same values;
// and no text is smaller than 13px.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./mobile/style.css', import.meta.url), 'utf8')
const desktop = readFileSync(new URL('../src/renderer/src/themes/a3.css', import.meta.url), 'utf8')

// The custom properties of the first block that `opener` starts.
function tokens(source: string, opener: RegExp): Record<string, string> {
  const at = source.search(opener)
  assert.ok(at >= 0, `no block ${opener}`)
  const from = source.indexOf('{', at) + 1
  const body = source.slice(from, source.indexOf('}', from))
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1]!, m[2]!.trim()]))
}

const dark = tokens(css, /^:root\s*\{/m)
const light = { ...dark, ...tokens(css, /@media \(prefers-color-scheme: light\)\s*\{\s*:root/) }

type Rgba = [number, number, number, number]
function colour(scheme: Record<string, string>, value: string): Rgba {
  const v = value.match(/^var\((--[\w-]+)\)$/)
  if (v) return colour(scheme, scheme[v[1]!] ?? assert.fail(`no ${v[1]}`))
  const hex = value.match(/^#([0-9a-f]{6})$/i)
  if (hex) return [0, 2, 4].map(i => parseInt(hex[1]!.slice(i, i + 2), 16)).concat(1) as Rgba
  const rgba = value.match(/^rgba?\(([^)]+)\)$/)
  if (rgba) {
    const [r, g, b, a = 1] = rgba[1]!.split(',').map(Number)
    return [r!, g!, b!, a]
  }
  return assert.fail(`not a colour: ${value}`)
}

// A see-through colour as it shows over the surface under it.
const over = (top: Rgba, under: Rgba): Rgba => [0, 1, 2].map(i => top[i]! * top[3] + under[i]! * (1 - top[3])).concat(1) as Rgba
const luminance = (c: Rgba) => {
  const [r, g, b] = c.slice(0, 3).map(v => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const ratio = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

// [foreground, background, the surface under a see-through background, least ratio, where].
const TEXT = 4.5
const MARK = 3
const PAIRS: [string, string, string, number, string][] = [
  ...['--bg', '--panel', '--panel-2'].flatMap(bg => [
    ['--text', bg, bg, TEXT, 'text'],
    ['--quiet', bg, bg, TEXT, 'quiet text: meta, tabs, chips, footer'],
    ['--edge', bg, bg, MARK, 'control borders'],
    ['--accent', bg, bg, MARK, 'focus ring, chosen tab, recommended option'],
  ] as [string, string, string, number, string][]),
  ['--accent-ink', '--accent-soft', '--panel', TEXT, '.chip.accent'],
  ['--accent-ink', '--panel-2', '--panel-2', TEXT, '.option .key'],
  ['--on-accent', '--accent', '--accent', TEXT, '.btn.primary, .count, .option.picked'],
  ['--good', '--panel-2', '--panel-2', TEXT, '.chip.good'],
  ['--good', '--panel', '--panel', MARK, '.dot.on'],
  ['--warn', '--panel-2', '--panel-2', TEXT, '.chip.warn'],
  ['--warn', '--panel', '--panel', TEXT, '.small.warn'],
  ['--bad', '--panel-2', '--panel-2', TEXT, '.btn.deny, .notice.bad'],
  ['--bad', '--bg', '--bg', TEXT, '.banner'],
  ['--on-good', '--good', '--good', TEXT, '.btn.allow'],
  ['--on-warn', '--warn', '--warn', TEXT, '.btn.armed'],
]

for (const [name, scheme] of [['dark', dark], ['light', light]] as const) {
  test(`phone page, ${name}: text 4.5:1, borders and marks 3:1`, () => {
    const low = PAIRS.flatMap(([fg, bg, under, least, where]) => {
      const back = over(colour(scheme, scheme[bg]!), colour(scheme, scheme[under]!))
      const got = ratio(over(colour(scheme, scheme[fg]!), back), back)
      return got >= least ? [] : [`${fg} on ${bg} (${where}): ${got.toFixed(2)} < ${least}`]
    })
    assert.deepEqual(low, [])
  })
}

test('phone page, dark: the tokens it shares with the desktop default theme have its values', () => {
  const a3 = tokens(desktop, /:where\(:root\)/)
  for (const name of ['--bg', '--panel', '--panel-2', '--line', '--text', '--quiet', '--accent', '--accent-soft', '--on-accent', '--good', '--warn', '--bad']) {
    assert.equal(dark[name], a3[name], name)
  }
})

test('phone page: colours only in the token blocks, no text under 13px', () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^:root\s*\{[^}]*\}/m, '').replace(/@media \(prefers-color-scheme: light\)\s*\{\s*:root\s*\{[^}]*\}\s*\}/, '')
  assert.deepEqual(rules.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi), null)
  const sizes = [...rules.matchAll(/font-size:\s*(\d+)px|font:[^;]*?\b(\d+)px/g)].map(m => Number(m[1] ?? m[2]))
  assert.ok(sizes.length > 5)
  assert.deepEqual(sizes.filter(size => size < 13), [])
})
