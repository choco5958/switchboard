import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { DEFAULT_THEME, THEMES, themeOf } from './theme'

const dir = join(import.meta.dirname, 'themes')

test('every listed theme has its file, and every file is listed', () => {
  const files = readdirSync(dir).filter(name => name.endsWith('.css')).map(name => name.replace(/\.css$/, ''))
  expect(files.sort()).toEqual(THEMES.map(t => t.id).sort())
  for (const { id } of THEMES) expect(readFileSync(join(dir, `${id}.css`), 'utf8')).toContain(`[data-theme='${id}']`)
})

test('an unknown or missing theme falls back to the default', () => {
  expect(themeOf('crt')).toBe('crt')
  expect(themeOf('gone')).toBe(DEFAULT_THEME)
  expect(themeOf(undefined)).toBe(DEFAULT_THEME)
  expect(themeOf(3)).toBe(DEFAULT_THEME)
})

test('labels avoid em dash, en dash and the middle dot', () => {
  for (const { label } of THEMES) expect(label).not.toMatch(/[\u2014\u2013\u00b7]/)
})

// Contrast over the theme tokens (WCAG 2 relative luminance). Each theme's first block holds its
// tokens; a3 is the fallback for any token a theme leaves out. A token may name another one
// (var(--text)) or be translucent (--accent-soft), which is laid over the surface under it.
type Rgba = [number, number, number, number]

function tokens(css: string): Record<string, string> {
  const head = css.slice(0, css.indexOf('}'))
  return Object.fromEntries([...head.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1]!, m[2]!.trim()]))
}

function colour(value: string | undefined, all: Record<string, string>, depth = 0): Rgba | null {
  if (!value || depth > 4) return null
  const ref = value.match(/^var\(--([\w-]+)\)$/)
  if (ref) return colour(all[ref[1]!], all, depth + 1)
  const hex = value.match(/^#([0-9a-fA-F]{6})$/)
  if (hex) return [...[0, 2, 4].map(i => parseInt(hex[1]!.slice(i, i + 2), 16)), 1] as Rgba
  const rgba = value.match(/^rgba?\(([^)]+)\)$/)
  if (!rgba) return null
  const [r = 0, g = 0, b = 0, a = 1] = rgba[1]!.split(',').map(Number)
  return [r, g, b, a]
}

function over(top: Rgba, under: Rgba): Rgba {
  return [...[0, 1, 2].map(i => top[i]! * top[3] + under[i]! * (1 - top[3])), 1] as Rgba
}

function luminance([r, g, b]: Rgba): number {
  const linear = [r, g, b].map(c => c / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return [0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => sum + weight * (linear[i] ?? 0), 0)
}

function contrast(a: Rgba, b: Rgba): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

// [foreground, background, least ratio, surface under a translucent background]
type Pair = [string, string, number, string?]

// Every pair in every theme (a3 under each); the ones below their ratio come back as lines.
function lowContrast(pairs: Pair[]): string[] {
  const base = tokens(readFileSync(join(dir, 'a3.css'), 'utf8'))
  const low: string[] = []
  for (const { id } of THEMES) {
    const t = { ...base, ...tokens(readFileSync(join(dir, `${id}.css`), 'utf8')) }
    for (const [fg, bg, least, under] of pairs) {
      const a = colour(t[fg], t)
      let b = colour(t[bg], t)
      if (b && under) b = over(b, colour(t[under], t) ?? b)
      if (!a || !b) {
        low.push(`${id}: no ${a ? bg : fg}`)
        continue
      }
      const ratio = contrast(a, b)
      if (ratio < least) low.push(`${id}: ${fg} on ${bg}${under ? ` over ${under}` : ''} ${ratio.toFixed(2)}`)
    }
  }
  return low
}

const SURFACES = ['bg', 'panel', 'panel-2']
const on = (fgs: string[], bgs: string[], least: number): Pair[] => fgs.flatMap(fg => bgs.map((bg): Pair => [fg, bg, least]))

test('text, quiet text, the accent and the status colours reach 4.5:1 on every surface', () => {
  expect(lowContrast(on(['text', 'quiet', 'accent', 'good', 'warn', 'bad'], SURFACES, 4.5))).toEqual([])
})

test('badge and button text reaches 4.5:1 on its fill: the accent, the task colours, good and warn', () => {
  const fills = on(['on-accent'], ['accent', 'task-0', 'task-1', 'task-2', 'task-3', 'task-4', 'task-5'], 4.5)
  expect(lowContrast([...fills, ['on-good', 'good', 4.5], ['on-warn', 'warn', 4.5]])).toEqual([])
})

test('a selected row (accent-soft over a panel) keeps its text at 4.5:1', () => {
  expect(lowContrast(['panel', 'panel-2'].map((under): Pair => ['on-accent-soft', 'accent-soft', 4.5, under]))).toEqual([])
})

test('field and button borders and the focus ring reach 3:1 on every surface', () => {
  expect(lowContrast(on(['line-strong', 'focus'], SURFACES, 3))).toEqual([])
})

// Every theme sets every colour token of the base theme itself, so none silently shows a3's navy.
// Fonts may fall back on purpose. A terminal palette, when a theme has one, is complete.
test('every theme defines every colour token, and a terminal palette has all sixteen colours', () => {
  const names = (css: string) => new Set([...css.slice(0, css.indexOf('}')).matchAll(/--([\w-]+):/g)].map(m => m[1]))
  const colours = [...names(readFileSync(join(dir, 'a3.css'), 'utf8'))].filter(name => name !== 'mono' && name !== 'sans')
  const missing: string[] = []
  for (const { id } of THEMES) {
    const own = names(readFileSync(join(dir, `${id}.css`), 'utf8'))
    for (const name of colours) if (!own.has(name)) missing.push(`${id}: --${name}`)
    const ansi = Array.from({ length: 16 }, (_, i) => `term-${i}`)
    if (ansi.some(name => own.has(name))) for (const name of ansi) if (!own.has(name)) missing.push(`${id}: --${name}`)
  }
  expect(colours.length).toBeGreaterThan(15)
  expect(missing).toEqual([])
})
