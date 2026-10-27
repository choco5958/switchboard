import type { IdeApi } from '../../shared/types'

declare global {
  interface Window {
    ide: IdeApi
  }
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<import('electron').WebviewTag>, import('electron').WebviewTag> & {
        src?: string
        partition?: string
      }
    }
  }
}
