// In the Tauri shell (docs/tauri-이전.md) there is no preload: window.ide and window.ideDebug
// come from the same table of the page's calls (src/shared/ideCalls.ts), sent to the shell,
// which relays them to the app's Node host. In Electron this file does nothing.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { IDE_CALLS, IDE_DEBUG_CALLS, buildApi, encodeArgs } from '../../shared/ideCalls'

if ('__TAURI_INTERNALS__' in window) {
  const shell = {
    invoke: (channel: string, args: unknown[]) => invoke('ide_invoke', { channel, args: encodeArgs(args) }),
    send: (channel: string, args: unknown[]) => void invoke('ide_send', { channel, args: encodeArgs(args) }),
    listen: (channel: string, listener: (payload: unknown) => void) => {
      let off: (() => void) | null = null
      let gone = false
      void listen(channel, event => listener(event.payload)).then(unlisten => (gone ? unlisten() : (off = unlisten)))
      return () => {
        gone = true
        off?.()
      }
    },
  }
  Object.assign(window, { ide: buildApi(IDE_CALLS, shell), ideDebug: buildApi(IDE_DEBUG_CALLS, shell) })
}
