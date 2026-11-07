import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

// Files dragged from Finder or Explorer onto a terminal go in as their paths, as a terminal app
// types them, so an agent CLI reads them as files (Claude Code attaches a dropped image). Only
// the Tauri shell hands the page a dropped file's path; in Electron this does nothing.

// The paths as typed in the terminal, with a space after them as Terminal.app leaves one. On
// macOS and Linux a character the shell treats specially gets a backslash (Terminal.app, iTerm2),
// and a path with a line break goes in single quotes, where a backslash would join the lines.
// On Windows a path with a space or a special character goes in double quotes (Windows Terminal).
export function droppedText(paths: readonly string[], windows: boolean): string {
  const one = (path: string) => {
    if (windows) return /[\s&()[\]{};,'`$@#]/.test(path) ? `"${path}"` : path
    if (/[\n\r]/.test(path)) return `'${path.replace(/'/g, `'\\''`)}'`
    return path.replace(/[\s!"#$&'()*;<>?[\\\]^`{|}~]/g, '\\$&')
  }
  return paths.length === 0 ? '' : `${paths.map(one).join(' ')} `
}

// Where in the page a drop landed. Tauri 2.12 (wry 0.57) reports the point in CSS pixels on
// macOS and Linux but in device pixels on Windows, though it calls both physical.
export function dropPoint(position: { x: number; y: number }, windows: boolean, scale: number): { x: number; y: number } {
  const by = windows && scale > 0 ? scale : 1
  return { x: position.x / by, y: position.y / by }
}

type Target = { box: HTMLElement; paste: (text: string) => void }

const targets = new Set<Target>()
let listening = false
const WINDOWS = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent)

// The terminal whose box holds the topmost element at the point: one under a dialog or a menu is
// not hit, and a hidden one has no box.
function targetAt(position: { x: number; y: number }): Target | null {
  const { x, y } = dropPoint(position, WINDOWS, window.devicePixelRatio)
  const hit = document.elementFromPoint(x, y)
  if (!hit) return null
  for (const target of targets) if (target.box.contains(hit)) return target
  return null
}

function listen() {
  if (listening || !('__TAURI_INTERNALS__' in window)) return
  listening = true
  let over: Target | null = null
  const mark = (target: Target | null) => {
    if (over === target) return
    over?.box.classList.remove('drop-on')
    target?.box.classList.add('drop-on')
    over = target
  }
  void getCurrentWebviewWindow().onDragDropEvent(({ payload }) => {
    if (payload.type === 'leave') return mark(null)
    const target = targetAt(payload.position)
    if (payload.type !== 'drop') return mark(target)
    mark(null)
    if (target && payload.paths.length > 0) target.paste(droppedText(payload.paths, WINDOWS))
  })
}

// A terminal takes the files dropped on its box until the returned function is called.
export function acceptDrops(box: HTMLElement, paste: (text: string) => void): () => void {
  const target = { box, paste }
  targets.add(target)
  listen()
  return () => {
    targets.delete(target)
    box.classList.remove('drop-on')
  }
}
