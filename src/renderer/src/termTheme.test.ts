import { expect, test } from 'vitest'
import { termTheme } from './termTheme'

const from = (tokens: Record<string, string>) => (name: string) => tokens[name] ?? ''

test('a theme without terminal tokens keeps xterm colours and uses the window tokens', () => {
  const theme = termTheme(from({ '--bg': '#000000', '--text': '#ffffff', '--accent': '#5b8cff', '--accent-soft': 'rgba(1, 2, 3, 0.2)' }))
  expect(theme).toEqual({ background: '#000000', foreground: '#ffffff', cursor: '#5b8cff', selectionBackground: 'rgba(1, 2, 3, 0.2)' })
})

test('a theme with the sixteen ANSI tokens, cursor and selection sets them all', () => {
  const tokens: Record<string, string> = { '--bg': '#282a36', '--text': '#f8f8f2', '--term-cursor': '#f8f8f2', '--term-selection': '#44475a' }
  for (let i = 0; i < 16; i++) tokens[`--term-${i}`] = `#0000${i.toString(16).padStart(2, '0')}`
  const theme = termTheme(from(tokens))
  expect(theme.black).toBe('#000000')
  expect(theme.red).toBe('#000001')
  expect(theme.brightWhite).toBe('#00000f')
  expect(theme.cursor).toBe('#f8f8f2')
  expect(theme.selectionBackground).toBe('#44475a')
})

test('a partial ANSI palette is ignored rather than mixed with xterm colours', () => {
  const theme = termTheme(from({ '--term-0': '#111111', '--term-1': '#222222' }))
  expect(theme.black).toBeUndefined()
  expect(theme.red).toBeUndefined()
})
