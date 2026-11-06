import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { WebviewTag } from 'electron'
import { invoke } from '@tauri-apps/api/core'
import { webviewSurface, type PageSurface } from './pageSurface'
import { tauriSurface } from './tauriSurface'

type Props = { src: string; visible: boolean; onSurface: (surface: PageSurface | null) => void }

// The in-app browser's page as the shell draws it; the browser screen gets its surface
// (pageSurface.ts). Electron: a <webview> in the browser's own session. Tauri: a child webview
// the shell keeps over this element's spot (src-tauri/src/browser.rs).
export function PageView(props: Props) {
  return '__TAURI_INTERNALS__' in window ? <TauriPage {...props} /> : <ElectronPage {...props} />
}

function ElectronPage({ src, onSurface }: Props) {
  const attach = useCallback((element: WebviewTag | null) => onSurface(element ? webviewSurface(element) : null), [onSurface])
  return <webview ref={attach} src={src} partition="persist:claude-ide" className="webview" />
}

function TauriPage({ src, visible, onSurface }: Props) {
  const spot = useRef<HTMLDivElement>(null)
  // One page for the life of the browser screen, as Electron keeps its <webview>.
  const surface = useMemo(() => tauriSurface(src), [])
  const started = useRef(false)
  useEffect(() => {
    onSurface(surface)
    return () => onSurface(null)
  }, [surface, onSurface])

  // Over the spot, as it moves and resizes; hidden while the browser screen is not shown.
  useEffect(() => {
    const element = spot.current
    if (!element) return
    let last = ''
    // Something of the app's drawn over the spot (a dialog, the palette, a menu): the page is drawn
    // above the app, so it would hide that. A few points across the spot, not its corners, so a
    // toast at the window's edge leaves the page shown.
    const covered = (r: DOMRect) =>
      [[0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]].some(([fx = 0, fy = 0]) => {
        const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy)
        return hit !== null && !element.contains(hit)
      })
    const place = () => {
      const r = element.getBoundingClientRect()
      const shown = visible && r.width > 0 && r.height > 0 && !covered(r)
      // The window's height too: full screen drops the title bar the page's place is measured below.
      const now = `${r.left},${r.top},${r.width},${r.height},${shown},${window.innerHeight}`
      if (now === last) return
      last = now
      void invoke('browser_place', { url: 'about:blank', x: r.left, y: r.top, width: r.width, height: r.height, visible: shown, viewport: window.innerHeight }).then(() => {
        if (started.current) return
        started.current = true
        void surface.load(src)
      })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    // A spot can move without changing size (the sidebar, a notice above), and a dialog can open over it.
    const timer = setInterval(place, 250)
    return () => {
      observer.disconnect()
      clearInterval(timer)
    }
  }, [visible, surface])

  // A new address from the screen before its first page was ready (BrowserView `src`).
  useEffect(() => {
    if (started.current) void surface.load(src)
  }, [src])

  return <div ref={spot} className="webview" />
}
