// In the Tauri shell (docs/tauri-이전.md) there is no preload: window.ide and window.ideDebug
// come from the same table of the page's calls (src/shared/ideCalls.ts), sent to the shell,
// which relays them to the app's Node host. In Electron this file does nothing.
//
// Everything from the host comes on one event, ide:event, in the order the host wrote it: its
// events ({channel, payload}) and the answers to the page's calls ({reply, value | error}). A call
// answered by the command's own return could arrive after a change the host sent later, and the
// page would keep the older state (connected() answering false after onConnection heard true).
// Listeners are the page's own, in place at once, as Electron's are.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { IDE_CALLS, IDE_DEBUG_CALLS, buildApi, encodeArgs } from '../../shared/ideCalls'

type HostMessage = { channel?: string; payload?: unknown; reply?: string; value?: unknown; error?: unknown }

if ('__TAURI_INTERNALS__' in window) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const waiting = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let next = 0
  const heard = listen<HostMessage>('ide:event', event => {
    const message = event.payload
    if (typeof message.reply === 'string') {
      const call = waiting.get(message.reply)
      waiting.delete(message.reply)
      if (message.error !== undefined && message.error !== null) call?.reject(new Error(String(message.error)))
      else call?.resolve(message.value ?? null)
      return
    }
    for (const listener of [...(listeners.get(message.channel ?? '') ?? [])]) {
      try {
        listener(message.payload)
      } catch (error) {
        console.error(error)
      }
    }
  })

  const shell = {
    invoke: async (channel: string, args: unknown[]) => {
      // The answer comes on ide:event, which has to be heard by then.
      await heard
      const call = `${Date.now().toString(36)}-${next++}`
      const answer = new Promise((resolve, reject) => waiting.set(call, { resolve, reject }))
      try {
        await invoke('ide_invoke', { call, channel, args: encodeArgs(args) })
      } catch (error) {
        waiting.delete(call)
        throw error instanceof Error ? error : new Error(String(error))
      }
      return answer
    },
    send: (channel: string, args: unknown[]) => void invoke('ide_send', { channel, args: encodeArgs(args) }),
    listen: (channel: string, listener: (payload: unknown) => void) => {
      let set = listeners.get(channel)
      if (!set) listeners.set(channel, (set = new Set()))
      set.add(listener)
      return () => void listeners.get(channel)?.delete(listener)
    },
  }
  Object.assign(window, { ide: buildApi(IDE_CALLS, shell), ideDebug: buildApi(IDE_DEBUG_CALLS, shell) })
}
