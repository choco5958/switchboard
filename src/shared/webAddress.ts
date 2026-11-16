// Which addresses the app opens, and where: for a link a CLI opens through BROWSER
// (src/main/openUrl.ts, whose script embeds the source of both functions, so each stands alone)
// and for one pressed in a terminal (src/renderer/src/termLinks.ts).

// Only a web address opens: open and xdg-open would take another scheme to whatever app owns it
// (or a file), and a word that starts with '-' as an option of their own. The address the
// browser gets is the one URL wrote out again, which always starts with its scheme.
export function webAddress(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

// An address on this computer, which opens in the in-app browser.
export function isLocalAddress(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  const parts = host.split('.').map(Number)
  return parts.length === 4 && parts[0] === 127 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
}
