import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { createReplay } from './termReplay'
import { t } from '../../shared/i18n'
import { termTheme } from './termTheme'

// Colours from the theme tokens, so the terminal follows the IDE theme.
function themeFromTokens(): ITheme {
  const css = getComputedStyle(document.documentElement)
  return termTheme(name => css.getPropertyValue(name).trim())
}

// One xterm bound to one terminal in the main process. It stays mounted while
// hidden so scrollback and the running program survive dock tab switches.
export function TerminalView({ id, visible, themeKey }: { id: string; visible: boolean; themeKey: string }) {
  const box = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!box.current) return
    const css = getComputedStyle(document.documentElement)
    const xterm = new Terminal({
      fontFamily: css.getPropertyValue('--mono').trim() || 'monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: themeFromTokens(),
    })
    const fitter = new FitAddon()
    xterm.loadAddon(fitter)
    xterm.open(box.current)
    term.current = xterm
    fit.current = fitter

    let live = true
    // Replay what ran before this view existed (a renderer reload, a new window);
    // live output that beats the buffer here waits and is not written twice.
    const replay = createReplay(data => {
      if (live) xterm.write(data)
    })
    void window.ide.termBuffer(id).then(
      saved => replay.buffer(saved.data, saved.seq),
      () => replay.buffer('', 0),
    )
    const offData = window.ide.onTermData(event => {
      if (event.id === id) replay.live(event.seq, event.data)
    })
    const offExit = window.ide.onTermExit(event => {
      if (event.id === id) replay.live(Infinity, `\r\n\x1b[2m[${t('term.exited', { code: event.exitCode })}]\x1b[0m\r\n`)
    })
    const input = xterm.onData(data => window.ide.termWrite(id, data))
    const resized = xterm.onResize(({ cols, rows }) => window.ide.termResize(id, cols, rows))
    const observer = new ResizeObserver(() => {
      // A hidden dock tab has no size; fitting it would shrink the program to nothing.
      if (box.current && box.current.clientWidth > 0 && box.current.clientHeight > 0) fitter.fit()
    })
    observer.observe(box.current)

    return () => {
      live = false
      observer.disconnect()
      offData()
      offExit()
      input.dispose()
      resized.dispose()
      xterm.dispose()
    }
  }, [id])

  useEffect(() => {
    if (!visible) return
    requestAnimationFrame(() => {
      fit.current?.fit()
      term.current?.focus()
    })
  }, [visible])

  // The App applies the theme in its own effect, which runs after this one; read the tokens a frame later.
  useEffect(() => {
    requestAnimationFrame(() => {
      if (term.current) term.current.options.theme = themeFromTokens()
    })
  }, [themeKey])

  return <div ref={box} className="terminal-view" style={{ display: visible ? 'block' : 'none' }} />
}
