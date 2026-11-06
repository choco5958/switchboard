// Every call the page makes (window.ide, window.ideDebug): the IPC channel it goes on and how.
// The Electron preload (src/preload/index.ts) and the Tauri page layer build the same API from
// this one table, so the two shells can never answer different names (docs/tauri-이전.md).
//
// invoke: a call with an answer. send: a call without one. listen: events the shell sends;
// the listener gets the event's payload. `args` turns the method's arguments into the channel's.

export type IdeCall =
  | { kind: 'invoke' | 'send'; channel: string; args?: (...args: any[]) => unknown[] }
  | { kind: 'listen'; channel: string }

export const IDE_CALLS = {
  state: { kind: 'invoke', channel: 'bridge:state' },
  answer: { kind: 'invoke', channel: 'bridge:answer' },
  hold: { kind: 'invoke', channel: 'bridge:hold' },
  forward: { kind: 'invoke', channel: 'bridge:forward' },
  approve: { kind: 'invoke', channel: 'bridge:approve' },
  connected: { kind: 'invoke', channel: 'bridge:connected' },
  bridgeProblem: { kind: 'invoke', channel: 'bridge:problem' },
  openBridgeLog: { kind: 'invoke', channel: 'bridge:openLog' },
  send: { kind: 'invoke', channel: 'bridge:send' },
  saveShot: { kind: 'invoke', channel: 'shots:save' },
  command: { kind: 'invoke', channel: 'bridge:command' },
  commandResult: { kind: 'invoke', channel: 'bridge:call', args: (id: number) => ['GET', `/commands/${id}`] },
  bridge: { kind: 'invoke', channel: 'bridge:call' },
  linearList: { kind: 'invoke', channel: 'linear:list' },
  linearAvailable: { kind: 'invoke', channel: 'linear:available' },
  checkWorktree: { kind: 'invoke', channel: 'worktree:check' },
  removeWorktree: { kind: 'invoke', channel: 'worktree:remove' },
  devStop: { kind: 'invoke', channel: 'dev:stop' },
  devRestart: { kind: 'invoke', channel: 'dev:restart' },
  devPull: { kind: 'invoke', channel: 'dev:pull' },
  devGit: { kind: 'invoke', channel: 'dev:git' },
  devStatus: { kind: 'invoke', channel: 'dev:status' },
  devLog: { kind: 'invoke', channel: 'dev:log' },
  onDevChange: { kind: 'listen', channel: 'dev:change' },
  onChange: { kind: 'listen', channel: 'bridge:change' },
  onNotifyOpen: { kind: 'listen', channel: 'notify:open' },
  onConnection: { kind: 'listen', channel: 'bridge:connection' },
  termList: { kind: 'invoke', channel: 'term:list' },
  termOpen: { kind: 'invoke', channel: 'term:open' },
  termOpenAgent: { kind: 'invoke', channel: 'term:openAgent' },
  detectAgents: { kind: 'invoke', channel: 'agents:detect', args: (force?: boolean) => [force === true] },
  termBuffer: { kind: 'invoke', channel: 'term:buffer' },
  termWrite: { kind: 'send', channel: 'term:write' },
  termResize: { kind: 'send', channel: 'term:resize' },
  termClose: { kind: 'invoke', channel: 'term:close' },
  pickFolder: { kind: 'invoke', channel: 'term:pickFolder' },
  termKeeps: { kind: 'invoke', channel: 'term:keeps' },
  onTermData: { kind: 'listen', channel: 'term:data' },
  onTermExit: { kind: 'listen', channel: 'term:exit' },
  // A terminal the app opened by itself: a scheduled prompt's, or one for delegated work.
  onTermOpened: { kind: 'listen', channel: 'term:opened' },
  accountInfo: { kind: 'invoke', channel: 'account:info' },
  measureAccounts: { kind: 'invoke', channel: 'account:measure' },
  updateStatus: { kind: 'invoke', channel: 'update:status' },
  updateCheck: { kind: 'invoke', channel: 'update:check' },
  updateInstall: { kind: 'invoke', channel: 'update:install' },
  onUpdateStatus: { kind: 'listen', channel: 'update:status' },
  sessionHistory: { kind: 'invoke', channel: 'sessions:history' },
} satisfies Record<string, IdeCall>

// Dynamic debugging: its own bridge routes (comments, open requests, live sessions), the in-app
// browser views' failed requests, and scripts run in those views.
export const IDE_DEBUG_CALLS = {
  call: { kind: 'invoke', channel: 'debug:call' },
  onNet: { kind: 'listen', channel: 'browser:net' },
  run: { kind: 'invoke', channel: 'browser:run' },
} satisfies Record<string, IdeCall>

// JSON has no undefined, which Electron's IPC keeps and the handlers tell from null (an argument
// not given). The Tauri page layer sends this in its place; the Node host puts undefined back.
export const UNDEFINED_ARG = { $undefined: true } as const
export const encodeArgs = (args: unknown[]): unknown[] => args.map(arg => (arg === undefined ? UNDEFINED_ARG : arg))
export const decodeArgs = (args: unknown[]): unknown[] =>
  args.map(arg => (arg && typeof arg === 'object' && (arg as { $undefined?: unknown }).$undefined === true && Object.keys(arg).length === 1 ? undefined : arg))

// Builds an API object from a table with the shell's own three ways to reach it.
export function buildApi(
  calls: Record<string, IdeCall>,
  shell: {
    invoke: (channel: string, args: unknown[]) => Promise<unknown>
    send: (channel: string, args: unknown[]) => void
    listen: (channel: string, listener: (payload: unknown) => void) => () => void
  },
): Record<string, unknown> {
  const api: Record<string, unknown> = {}
  for (const [name, call] of Object.entries(calls)) {
    if (call.kind === 'listen') api[name] = (listener: (payload: unknown) => void) => shell.listen(call.channel, listener)
    else {
      const args = (given: unknown[]) => (call.args ? call.args(...given) : given)
      api[name] =
        call.kind === 'invoke'
          ? (...given: unknown[]) => shell.invoke(call.channel, args(given))
          : (...given: unknown[]) => shell.send(call.channel, args(given))
    }
  }
  return api
}
