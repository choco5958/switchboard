// How an answer is typed into an agent CLI running in an app terminal, so the CLI
// takes it as one prompt: bracketed paste when the CLI turned that mode on, then
// Enter on its own a moment later. Codex, Gemini CLI and Qwen Code treat an Enter
// that comes within 40 to 500 ms of pasted text as a newline, hence the pause.

export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'
export const ENTER = '\r'
export const ENTER_DELAY_MS = 600
// The terminal printed nothing for this long: the CLI is waiting for input, not
// drawing a spinner over a turn that is still running.
export const QUIET_MS = 1500

// Only newlines and tabs survive: an escape in an answer could end the paste early
// or send keys of its own.
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g, '')
}

// What goes into the pty before Enter. Without bracketed paste a newline would submit
// early, so the lines are joined into one.
export function typedInput(text: string, bracketed: boolean): string {
  const clean = cleanText(text).trim()
  if (bracketed) return `${PASTE_START}${clean}${PASTE_END}`
  return clean.replace(/\s*\n+\s*/g, ' ')
}

// Bracketed paste is on after the CLI printed ESC[?2004h, off after ESC[?2004l; the
// last of them in the output decides.
export function pasteModeAfter(current: boolean, output: string): boolean {
  const on = output.lastIndexOf('\x1b[?2004h')
  const off = output.lastIndexOf('\x1b[?2004l')
  if (on === -1 && off === -1) return current
  return on > off
}

// The pty's foreground process is the login shell again once the CLI has quit:
// typing then would run the answer as shell commands.
export function cliInFront(foreground: string, shell: string): boolean {
  const name = (path: string) => path.split('/').pop()?.replace(/^-/, '') ?? ''
  const front = name(foreground)
  return front !== '' && front !== name(shell) && !['login', 'sh', 'bash', 'zsh', 'fish'].includes(front)
}

export function readyToType(t: { alive: boolean; foreground: string; shell: string; lastOutput: number }, now: number): boolean {
  return t.alive && cliInFront(t.foreground, t.shell) && now - t.lastOutput >= QUIET_MS
}

// A terminal as the answer typing sees it, at the moment it asks.
export type TypingTarget = { alive: boolean; shell: string; lastOutput: number; paste: boolean; foreground: string; write: (data: string) => void }
