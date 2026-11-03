import { contextBridge, ipcRenderer } from 'electron'
import type { IdeApi } from '../shared/types'
import { IDE_CALLS, IDE_DEBUG_CALLS, buildApi } from '../shared/ideCalls'

// window.ide and window.ideDebug from the shared table of the page's calls (src/shared/ideCalls.ts),
// the same table the Tauri shell's page layer reads.
const shell = {
  invoke: (channel: string, args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  send: (channel: string, args: unknown[]) => ipcRenderer.send(channel, ...args),
  listen: (channel: string, listener: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => void ipcRenderer.off(channel, handler)
  },
}

contextBridge.exposeInMainWorld('ide', buildApi(IDE_CALLS, shell) as unknown as IdeApi)
contextBridge.exposeInMainWorld('ideDebug', buildApi(IDE_DEBUG_CALLS, shell))
