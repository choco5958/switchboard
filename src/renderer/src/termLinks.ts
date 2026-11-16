import type { ILinkHandler } from '@xterm/xterm'
import { t } from '../../shared/i18n'
import { isLocalAddress, webAddress } from '../../shared/webAddress'

// A web address in a terminal's output opens when pressed with ⌘ held (Ctrl on Windows and Linux),
// as in other terminals: one on this computer in the in-app browser, as when a CLI opens it itself
// (src/main/openUrl.ts), any other in the person's own browser. A press without the key stays the
// terminal's: it starts a selection, or goes to a program that reads the mouse.

const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)

// Where a link's address opens; null for anything but a web address (file:, javascript:, a word).
export function linkTarget(raw: string): { url: string; local: boolean } | null {
  const url = webAddress(raw)
  return url === null ? null : { url, local: isLocalAddress(url) }
}

export function linkKeyHeld(event: { metaKey: boolean; ctrlKey: boolean }, mac: boolean): boolean {
  return mac ? event.metaKey : event.ctrlKey
}

// What the pointer shows over a link: how to open it, under the address itself for a link the
// program named (OSC 8), whose words on screen can say one thing and lead to another.
export function linkHint(mac: boolean, address = ''): string {
  const how = t('term.linkHint', { key: mac ? '⌘' : 'Ctrl' })
  return address ? `${address}\n${how}` : how
}

function open(event: MouseEvent, address: string): void {
  if (!linkKeyHeld(event, MAC)) return
  const target = linkTarget(address)
  if (!target) return
  if (target.local) void window.ideDebug.call('POST', '/dev/open', { url: target.url })
  // The shell sends a new window's address to the person's browser and opens no window.
  else window.open(target.url, '_blank', 'noopener,noreferrer')
}

// The handlers of one terminal's links. `box` is the terminal's element: its tooltip says how a
// link opens while the pointer is over one.
export function termLinks(box: HTMLElement) {
  const leave = () => box.removeAttribute('title')
  // xterm's own handler for the links a program names would ask with confirm() and open a window.
  const named: ILinkHandler = {
    activate: open,
    hover: (_event, address) => {
      if (linkTarget(address)) box.title = linkHint(MAC, address)
    },
    leave,
  }
  return { open, named, hover: () => void (box.title = linkHint(MAC)), leave }
}
