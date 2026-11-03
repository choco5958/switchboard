import { useCallback } from 'react'
import type { WebviewTag } from 'electron'
import { webviewSurface, type PageSurface } from './pageSurface'

// The in-app browser's page as the shell draws it; the browser screen gets its surface
// (pageSurface.ts). Electron: a <webview> in the browser's own session.
export function PageView({ src, onSurface }: { src: string; visible: boolean; onSurface: (surface: PageSurface | null) => void }) {
  const attach = useCallback((element: WebviewTag | null) => onSurface(element ? webviewSurface(element) : null), [onSurface])
  return <webview ref={attach} src={src} partition="persist:claude-ide" className="webview" />
}
