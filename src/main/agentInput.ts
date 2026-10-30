// How an answer is typed into an agent CLI running in an app terminal, so the CLI
// takes it as one prompt: bracketed paste when the CLI turned that mode on, then
// Enter on its own a moment later. Codex, Gemini CLI and Qwen Code treat an Enter
// that comes within 40 to 500 ms of pasted text as a newline, hence the pause.

import { SHELL_NAMES } from './shell'

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
// early, so the lines are joined into one. Typing goes on without it too (a CLI that never
// turns the mode on would get nothing): the menu checks before the text and before Enter
// guard it, and a menu that comes up in between could still take keys of the text.
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
// typing then would run the answer as shell commands. Only the program names the
// terminal was opened for (`expect`) count as the CLI: with none, nothing does.
export function cliInFront(foreground: string, shell: string, expect: readonly string[] = []): boolean {
  const name = (path: string) => path.split(/[\\/]/).pop()?.replace(/^-/, '').replace(/\.(exe|cmd)$/i, '').toLowerCase() ?? ''
  const front = name(foreground)
  if (front === '' || front === name(shell) || SHELL_NAMES.includes(front)) return false
  // Another program the person started there (ssh, python) is not the CLI.
  return expect.some(bin => name(bin) === front)
}

// A menu the CLI shows now: its own "run this command?" confirmation, or a yes/no question
// waiting on the last line. Typed text and Enter would pick the highlighted option there, so
// nothing is typed while one is on screen. `rows`: the screen as it is (termScreen.ts), so a
// menu erased since, the person's own "> yes" and a quote in an answer are not on it.
const OPTION_WORDS = 'yes|no|allow|approve|deny|reject|always|don.?t|proceed|cancel|skip|accept|decline|trust|continue|run'
// The highlighted option: a selection marker (never a bare ">", which quotes and prompts use)
// before an option word, with or without its number.
const MARKED = new RegExp(`^[\\s│|┃]*(?:[›❯●▶➤]|>(?=\\s*\\d))\\s*(?:\\d{1,2}[.)]\\s*)?(?:${OPTION_WORDS})\\b`, 'i')
// Another option of the same menu: numbered, or an option word alone at the start.
const OPTION = new RegExp(`^[\\s│|┃]*(?:[›❯●▶➤]\\s*)?(?:\\d{1,2}[.)]\\s+\\S|(?:${OPTION_WORDS})\\b)`, 'i')
const YES_NO = /(?:\[(?:y\/n|y\/N|Y\/n)\]|\((?:y\/n|yes\/no)\))\s*[:?]?\s*$/i
export function permissionMenu(rows: readonly string[]): boolean {
  const lines = rows.map(line => line.trimEnd()).filter(line => line.trim() !== '').slice(-15)
  if (lines.length === 0) return false
  if (YES_NO.test(lines[lines.length - 1]!)) return true
  return lines.some((line, i) => MARKED.test(line) && lines.slice(Math.max(0, i - 6), i + 7).filter((other, j) => j !== Math.min(i, 6) && OPTION.test(other)).length >= 1)
}

// The shell's own prompt on the last line: PowerShell's "PS C:\work>" or cmd's "C:\work>".
// A prompt the person styled themselves (oh-my-posh and the like) is not recognised.
const SHELL_PROMPT = /^(?:PS [^>]*|[A-Za-z]:\\[^>]*)>$/
export function shellPromptShown(rows: readonly string[]): boolean {
  const last = rows.map(line => line.trim()).filter(Boolean).at(-1)
  return last !== undefined && SHELL_PROMPT.test(last)
}

// On Windows node-pty gives no foreground program: its `process` is the terminal name the
// spawn was given ('xterm-256color'). There a terminal the app opened for a CLI (`expect` set)
// counts as the CLI's until the screen shows the shell's prompt again, the CLI having quit.
export function cliInFrontOn(platform: string | undefined, t: { foreground: string; shell: string; expect?: string[]; screen?: readonly string[] }): boolean {
  if (platform === 'win32') return (t.expect?.length ?? 0) > 0 && !shellPromptShown(t.screen ?? [])
  return cliInFront(t.foreground, t.shell, t.expect)
}

// Why typing waits now, or null when it may go: the CLI is not in front, still printing, or
// showing a menu (permissionMenu). `screen`: the terminal's rows as they are. `platform`:
// where the terminal runs (process.platform); left out, the foreground program decides.
export function typingBlock(
  t: { alive: boolean; foreground: string; shell: string; lastOutput: number; expect?: string[]; screen?: readonly string[]; platform?: string },
  now: number,
): 'gone' | 'busy' | 'menu' | null {
  if (!t.alive || !cliInFrontOn(t.platform, t)) return 'gone'
  if (now - t.lastOutput < QUIET_MS) return 'busy'
  return permissionMenu(t.screen ?? []) ? 'menu' : null
}

export function readyToType(t: Parameters<typeof typingBlock>[0], now: number): boolean {
  return typingBlock(t, now) === null
}

// Whether the Enter that follows the typed text may still go: the CLI is in front and no menu
// came up since the text went in. Its echo of the text makes the screen busy, which is no reason.
export function enterAllowed(t: Parameters<typeof typingBlock>[0] | undefined): boolean {
  return t !== undefined && typingBlock({ ...t, lastOutput: -Infinity }, 0) === null
}

// A terminal as the answer typing sees it, at the moment it asks.
// `agent`: the CLI the app opened the terminal for; a session of another agent is never typed there.
// `expect`: the program names of the terminal's CLI; only they count as it.
// `platform`: process.platform, which decides how the CLI in front is told (cliInFrontOn).
export type TypingTarget = {
  agent?: string
  alive: boolean
  shell: string
  lastOutput: number
  paste: boolean
  foreground: string
  expect?: string[]
  screen?: readonly string[]
  platform?: string
  write: (data: string) => void
}
