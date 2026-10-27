import type { ITheme } from '@xterm/xterm'

// xterm's sixteen ANSI colour names in order; a theme sets them as --term-0 to --term-15.
const ANSI = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const

// Terminal colours from the theme tokens. Background, text, cursor and selection follow the window tokens
// unless the theme gives --term-cursor or --term-selection; the ANSI palette is used only when the theme
// gives all sixteen, otherwise xterm keeps its own.
export function termTheme(token: (name: string) => string): ITheme {
  const theme: ITheme = {
    background: token('--bg') || '#111',
    foreground: token('--text') || '#ddd',
    cursor: token('--term-cursor') || token('--accent') || '#8af',
    selectionBackground: token('--term-selection') || token('--accent-soft') || '#335',
  }
  const ansi = ANSI.map((_, i) => token(`--term-${i}`))
  if (ansi.every(Boolean)) ANSI.forEach((name, i) => (theme[name] = ansi[i]))
  return theme
}
