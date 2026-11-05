// The Tauri shell's Node side (docs/tauri-이전.md): the same app logic the Electron shell runs
// (src/main/core.ts), on a Platform that talks to the Rust shell over standard input and output,
// one JSON message per line. Standard output carries only those messages; logs go to stderr.
//
// From Rust: invoke {id, channel, args} and send {channel, args} (the page's calls, by the
// channels of src/shared/ideCalls.ts), reply {id, value | error} (to an os request), event
// {name, ...} (power, focus, a clicked notification) and quit.
// To Rust: result {id, value | error}, emit {channel, payload} (an event for the page), os {id?,
// op, ...} (something only the shell can do), ready once the app has started, and quitDone.

import { createInterface } from 'node:readline'
import type { AppKey } from '../main/appKey'
import type { IdleState, Platform, PowerEvent, QuitHook } from '../main/platform'
import { usePlatform } from '../main/platform'
import { nodeRoot } from '../main/appRoot'
import { registerCore, startCore, watchCore } from '../main/core'
import { terminalStates } from '../main/terminals'
import { registerUpdates, startHostUpdates } from '../main/updateFlow'
import { useTestReleases } from '../main/updateSignature'
import { resolveLang, setLang } from '../shared/i18n'
import { decodeArgs } from '../shared/ideCalls'

// What the shell knows at the start, as SWITCHBOARD_HOST (JSON).
type HostInfo = {
  version: string
  locale: string
  packaged: boolean
  appPath: string
  resourcesPath: string
  userDataPath: string
  appKey: AppKey
  // The shell's executable and process, for an update's swap (updateFlow.ts macUpdates).
  exePath: string
  appPid: number
  // The machine's own architecture (an x64 build emulated on ARM64 Windows says arm64).
  machineArch?: string
}

const info = JSON.parse(process.env.SWITCHBOARD_HOST ?? '{}') as HostInfo
delete process.env.SWITCHBOARD_HOST

// A check of the update path (scripts/tauri-update-check.ts), only in a run with nobody at the
// screen: this copy takes itself for an older version and updates from the check's own server,
// under the check's key. Not handed on: the copy the update starts again checks nothing.
const updateTest = process.env.CLAUDE_IDE_CAPTURE_JS ? process.env.CLAUDE_IDE_UPDATE_TEST : undefined
delete process.env.CLAUDE_IDE_UPDATE_TEST
if (updateTest) {
  const test = JSON.parse(updateTest) as { origin: string; key: string; version: string }
  useTestReleases(test.origin, test.key)
  info.version = test.version
}

// Everything the logic prints goes to stderr: stdout is the shell's channel.
for (const name of ['log', 'info', 'warn', 'debug'] as const) console[name] = (...args: unknown[]) => console.error(...args)

const write = (message: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(message)}\n`)

let nextId = 1
const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
const os = (op: string, fields: Record<string, unknown> = {}): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = nextId++
    waiting.set(id, { resolve, reject })
    write({ t: 'os', id, op, ...fields })
  })
const tell = (op: string, fields: Record<string, unknown> = {}) => write({ t: 'os', op, ...fields })

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>()
const power = new Map<PowerEvent, (() => void)[]>()
const clicks = new Map<number, () => void>()
const quitHooks: Record<'before' | 'will', QuitHook[]> = { before: [], will: [] }
let focused = true

const hostPlatform: Platform = {
  ipc: {
    handle: (channel, listener) => void handlers.set(channel, listener),
    on: (channel, listener) => void listeners.set(channel, listener),
  },
  send: (channel, payload) => write({ t: 'emit', channel, payload }),
  isPackaged: info.packaged,
  version: () => info.version,
  locale: () => info.locale,
  appPath: () => info.appPath,
  resourcesPath: () => info.resourcesPath,
  userDataPath: () => info.userDataPath,
  // Installed, the runtime copy of Resources/node carries node_modules (scripts/stage-tauri.ts).
  modulesPath: () => (info.packaged ? nodeRoot() : info.appPath),
  appKey: () => info.appKey,
  notificationsSupported: () => true,
  notify: (title, body, onClick) => {
    const id = nextId++
    if (onClick) clicks.set(id, onClick)
    tell('notify', { notification: id, title, body })
    // Taken back from the notification centre on macOS; elsewhere it stays (src-tauri/src/os.rs).
    return {
      close: () => {
        clicks.delete(id)
        tell('notifyClose', { notification: id })
      },
    }
  },
  messageBox: async box => Number(await os('messageBox', { box })),
  pickFolder: async title => ((await os('pickFolder', { title })) as string | null) ?? null,
  openPath: async path => String((await os('openPath', { path })) ?? ''),
  openExternal: async url => void (await os('openExternal', { url })),
  setBadge: text => tell('setBadge', { text }),
  onPower: (event, listener) => void power.set(event, [...(power.get(event) ?? []), listener]),
  idleState: async seconds => ((await os('idleState', { seconds })) as IdleState) ?? 'unknown',
  keepAwake: on => tell('keepAwake', { on }),
  windowFocused: () => focused,
  focusWindow: afterLoad => {
    tell('focusWindow')
    // The page in the Tauri window stays loaded while the window is hidden.
    afterLoad?.()
  },
  onQuit: (stage, hook) => void quitHooks[stage].push(hook),
  quit: () => tell('quit'),
}

// The quit runs the hooks of each stage, waits for what they hold, and ends the process (its
// 'exit' handlers still run: terminals that end with the app).
async function quitting(): Promise<void> {
  for (const stage of ['before', 'will'] as const) {
    const held: Promise<unknown>[] = []
    for (const hook of quitHooks[stage]) {
      try {
        hook(work => void held.push(work.catch(() => undefined)))
      } catch (error) {
        console.error('quit hook failed:', error)
      }
    }
    await Promise.all(held)
  }
  write({ t: 'quitDone' })
  process.exit(0)
}

async function onMessage(message: Record<string, any>): Promise<void> {
  if (message.t === 'invoke') {
    const handler = handlers.get(String(message.channel))
    try {
      if (!handler) throw new Error(`no handler for ${String(message.channel)}`)
      const value = await handler(undefined, ...decodeArgs((message.args as unknown[]) ?? []))
      write({ t: 'result', id: message.id, value: value ?? null })
    } catch (error) {
      write({ t: 'result', id: message.id, error: error instanceof Error ? error.message : String(error) })
    }
  } else if (message.t === 'send') {
    listeners.get(String(message.channel))?.(undefined, ...decodeArgs((message.args as unknown[]) ?? []))
  } else if (message.t === 'reply') {
    const one = waiting.get(Number(message.id))
    waiting.delete(Number(message.id))
    if (message.error) one?.reject(new Error(String(message.error)))
    else one?.resolve(message.value)
  } else if (message.t === 'event') {
    if (message.name === 'power') for (const listener of power.get(message.event as PowerEvent) ?? []) listener()
    else if (message.name === 'focus') focused = message.focused === true
    else if (message.name === 'notificationClick') {
      const click = clicks.get(Number(message.notification))
      clicks.delete(Number(message.notification))
      click?.()
    }
  } else if (message.t === 'quit') await quitting()
}

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return
  let message: Record<string, unknown>
  try {
    message = JSON.parse(line)
  } catch {
    console.error('host: not a message:', line.slice(0, 200))
    return
  }
  void onMessage(message).catch(error => console.error('host:', error))
})
// The shell went away without a quit: the app ends with it.
process.stdin.on('end', () => void quitting())

usePlatform(hostPlatform)
setLang(resolveLang(undefined, info.locale))
registerCore()
registerUpdates(hostPlatform.ipc, hostPlatform.send)
await startCore()
write({ t: 'ready' })
watchCore()
// Installed only, and never in a check without a person at the screen but the update path's.
if (info.packaged && (!process.env.CLAUDE_IDE_CAPTURE_JS || updateTest)) {
  startHostUpdates({ exe: info.exePath, pid: info.appPid, arch: info.machineArch, whenQuit: start => hostPlatform.onQuit('will', () => start()) }, terminalStates)
}
