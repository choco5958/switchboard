import { describe, expect, it } from 'vitest'
import { installsUpdates, stopBridgeNow } from './updater'

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
