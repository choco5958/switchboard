// What the app logic (core.ts and the modules it registers) needs from the shell it runs in:
// Electron today (index.ts), the Tauri host next (docs/tauri-이전.md). Nothing here imports
// Electron, so the same logic runs on a plain Node beside a Rust shell.

import type { AppKey } from './appKey'

// An IPC event as the logic sees it: handlers only ever skip it.
export type IpcEvent = unknown
export type Ipc = {
  handle(channel: string, listener: (event: IpcEvent, ...args: any[]) => unknown): void
  on(channel: string, listener: (event: IpcEvent, ...args: any[]) => void): void
}

export type MessageBox = {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  buttons: string[]
  defaultId?: number
  cancelId?: number
  message: string
  detail?: string
}

export type PowerEvent = 'lock-screen' | 'unlock-screen' | 'resume' | 'shutdown'
export type IdleState = 'active' | 'idle' | 'locked' | 'unknown'

// `hold`: the quit waits for this work, then carries on by itself.
export type QuitHook = (hold: (work: Promise<unknown>) => void) => void

export type Platform = {
  ipc: Ipc
  // An event for the window's page (window.ide listeners); nothing when no window is open.
  send(channel: string, payload: unknown): void
  isPackaged: boolean
  version(): string
  locale(): string
  // The app's own files: the repo when run from it, the packaged app's otherwise.
  appPath(): string
  // Resources of the installed app (Resources/node lives there).
  resourcesPath(): string
  userDataPath(): string
  // The folder whose node_modules the terminal host loads node-pty and the emulator from;
  // undefined: the host finds them itself (the Electron app's app.asar).
  modulesPath(): string | undefined
  // The key the app proves itself to the bridge with, kept by the system's keychain (appKey.ts).
  appKey(): AppKey
  notificationsSupported(): boolean
  notify(title: string, body: string, onClick?: () => void): void
  // The index of the button pressed.
  messageBox(box: MessageBox): Promise<number>
  pickFolder(title: string): Promise<string | null>
  openPath(path: string): Promise<string>
  openExternal(url: string): Promise<void>
  setBadge(text: string): void
  onPower(event: PowerEvent, listener: () => void): void
  idleState(seconds: number): Promise<IdleState>
  // Keeps the computer from sleeping while on (an agent works, awake.ts).
  keepAwake(on: boolean): void
  windowFocused(): boolean
  // Brings the window forward, opening it again if it was closed; `afterLoad` runs once its page listens.
  focusWindow(afterLoad?: () => void): void
  onQuit(stage: 'before' | 'will', hook: QuitHook): void
  quit(): void
}

let current: Platform | null = null

export function usePlatform(platform: Platform): void {
  current = platform
}

export function platform(): Platform {
  if (!current) throw new Error('no platform yet: the shell sets it before the app logic runs')
  return current
}
