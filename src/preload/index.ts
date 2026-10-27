import { contextBridge, ipcRenderer } from 'electron'
import type { IdeApi } from '../shared/types'

const api: IdeApi = {
  state: () => ipcRenderer.invoke('bridge:state'),
  answer: (id, choice, memo) => ipcRenderer.invoke('bridge:answer', id, choice, memo),
  hold: id => ipcRenderer.invoke('bridge:hold', id),
  connected: () => ipcRenderer.invoke('bridge:connected'),
  send: (sessionId, text, kind, taskTitle) => ipcRenderer.invoke('bridge:send', sessionId, text, kind, taskTitle),
  saveShot: dataUrl => ipcRenderer.invoke('shots:save', dataUrl),
  command: (sessionId, kind, payload) => ipcRenderer.invoke('bridge:command', sessionId, kind, payload),
  commandResult: id => ipcRenderer.invoke('bridge:call', 'GET', `/commands/${id}`),
  bridge: (method, path, body) => ipcRenderer.invoke('bridge:call', method, path, body),
  linearList: filter => ipcRenderer.invoke('linear:list', filter),
  checkWorktree: (path, branch) => ipcRenderer.invoke('worktree:check', path, branch),
  removeWorktree: (nodeId, path, force) => ipcRenderer.invoke('worktree:remove', nodeId, path, force),
  devStart: target => ipcRenderer.invoke('dev:start', target),
  devStop: id => ipcRenderer.invoke('dev:stop', id),
  devRestart: target => ipcRenderer.invoke('dev:restart', target),
  devPull: repo => ipcRenderer.invoke('dev:pull', repo),
  devGit: repo => ipcRenderer.invoke('dev:git', repo),
  devStatus: target => ipcRenderer.invoke('dev:status', target),
  devLog: id => ipcRenderer.invoke('dev:log', id),
  onDevChange: listener => {
    const handler = (_e: unknown, event: { id: string }) => listener(event)
    ipcRenderer.on('dev:change', handler)
    return () => ipcRenderer.off('dev:change', handler)
  },
  onChange: listener => {
    const handler = (_e: unknown, event: { type: string }) => listener(event)
    ipcRenderer.on('bridge:change', handler)
    return () => ipcRenderer.off('bridge:change', handler)
  },
  onConnection: listener => {
    const handler = (_e: unknown, connected: boolean) => listener(connected)
    ipcRenderer.on('bridge:connection', handler)
    return () => ipcRenderer.off('bridge:connection', handler)
  },
  termList: () => ipcRenderer.invoke('term:list'),
  termOpen: (cwd, claude, cols, rows) => ipcRenderer.invoke('term:open', cwd, claude, cols, rows),
  termOpenAgent: (cwd, agentId, cols, rows) => ipcRenderer.invoke('term:openAgent', cwd, agentId, cols, rows),
  detectAgents: force => ipcRenderer.invoke('agents:detect', force === true),
  termBuffer: id => ipcRenderer.invoke('term:buffer', id),
  termWrite: (id, data) => ipcRenderer.send('term:write', id, data),
  termResize: (id, cols, rows) => ipcRenderer.send('term:resize', id, cols, rows),
  termClose: id => ipcRenderer.invoke('term:close', id),
  pickFolder: () => ipcRenderer.invoke('term:pickFolder'),
  onTermData: listener => {
    const handler = (_e: unknown, event: { id: string; data: string; seq: number }) => listener(event)
    ipcRenderer.on('term:data', handler)
    return () => ipcRenderer.off('term:data', handler)
  },
  onTermExit: listener => {
    const handler = (_e: unknown, event: { id: string; exitCode: number }) => listener(event)
    ipcRenderer.on('term:exit', handler)
    return () => ipcRenderer.off('term:exit', handler)
  },
  accountInfo: () => ipcRenderer.invoke('account:info'),
}

contextBridge.exposeInMainWorld('ide', api)

// Dynamic debugging: its own bridge routes (comments, open requests, live sessions).
contextBridge.exposeInMainWorld('ideDebug', {
  call: (method: 'GET' | 'POST', path: string, body?: unknown) => ipcRenderer.invoke('debug:call', method, path, body),
})
