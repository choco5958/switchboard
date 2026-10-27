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
// tokens; a3 is the fallback for any token a theme leaves out.
function tokens(css: string): Record<string, string> {
  const head = css.slice(0, css.indexOf('}'))
  return Object.fromEntries([...head.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map(m => [m[1], m[2]]))
}

function luminance(hex: string): number {
  const linear = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return [0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => sum + weight * (linear[i] ?? 0), 0)
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

test('badge and primary button text, and status colours, reach 4.5:1 in every theme', () => {
  const base = tokens(readFileSync(join(dir, 'a3.css'), 'utf8'))
  const low: string[] = []
  for (const { id } of THEMES) {
    const t = { ...base, ...tokens(readFileSync(join(dir, `${id}.css`), 'utf8')) }
    const check = (fg: string, bg: string) => {
      const [a, b] = [t[fg], t[bg]]
      if (!a || !b) return low.push(`${id}: no ${a ? bg : fg}`)
      const ratio = contrast(a, b)
      if (ratio < 4.5) low.push(`${id}: ${fg} on ${bg} ${ratio.toFixed(2)}`)
    }
    for (const bg of ['accent', 'task-0', 'task-1', 'task-2', 'task-3', 'task-4', 'task-5']) check('on-accent', bg)
    for (const fg of ['text', 'quiet', 'good', 'warn', 'bad']) for (const bg of ['bg', 'panel', 'panel-2']) check(fg, bg)
  }
  expect(low).toEqual([])
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
