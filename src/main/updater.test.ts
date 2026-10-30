import { describe, expect, it, vi } from 'vitest'
import { installsUpdates, stopBridgeNow } from './updater'

// The real modules would install Electron's binary while the tests run, and two workers doing
// that at once collide (CI). These tests touch neither.
vi.mock('electron', () => ({ app: {}, Notification: class {}, shell: {} }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }))

describe('updates', () => {
  it('only Windows and the Linux AppImage install updates themselves', () => {
    expect(installsUpdates('win32', {})).toBe(true)
    expect(installsUpdates('linux', { APPIMAGE: '/home/me/Switchboard.AppImage' })).toBe(true)
    // A .deb: electron-updater would run pkexec or sudo for it.
    expect(installsUpdates('linux', {})).toBe(false)
    expect(installsUpdates('darwin', { APPIMAGE: '/x' })).toBe(false)
  })

  it('stops the bridge serving at quit time, not one remembered from the download', async () => {
    const killed: number[] = []
    let serving = 4100
    const pid = () => Promise.resolve(serving)
    // The bridge was restarted after the update came down.
    serving = 4200
    expect(await stopBridgeNow(pid, p => killed.push(p))).toBe(4200)
    expect(killed).toEqual([4200])
  })

  it('kills nothing when the bridge does not answer, answers too late, or names this process', async () => {
    const killed: number[] = []
    expect(await stopBridgeNow(() => Promise.resolve(null), p => killed.push(p))).toBe(null)
    expect(await stopBridgeNow(() => Promise.reject(new Error('down')), p => killed.push(p))).toBe(null)
    expect(await stopBridgeNow(() => new Promise(resolve => setTimeout(() => resolve(4300), 200)), p => killed.push(p), 20)).toBe(null)
    expect(await stopBridgeNow(() => Promise.resolve(process.pid), p => killed.push(p))).toBe(null)
    expect(killed).toEqual([])
  })
})
