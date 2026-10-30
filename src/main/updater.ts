// Updates of the installed app, from the GitHub releases (electron-builder.yml publish).
// Windows and the Linux AppImage download a new version and install it when the app quits.
// macOS installs only a signed update, and this app is not signed; a .deb (or any other
// Linux package) is the system package manager's to update, as the README says. There the
// person gets a notification that opens the download page.

import { app, Notification, shell } from 'electron'
import updater from 'electron-updater'
import { t } from '../shared/i18n'

export const RELEASES_URL = 'https://github.com/choco5958/switchboard/releases/latest'
const CHECK_MS = 6 * 3600_000
// A bridge that does not answer /health in this time is not waited for at quit.
const PID_WAIT_MS = 2000

// Whether this copy of the app installs updates itself. On Linux only the AppImage does
// (its runtime sets APPIMAGE); electron-updater would install a .deb with pkexec or sudo.
export function installsUpdates(platform: string = process.platform, env: Record<string, string | undefined> = process.env): boolean {
  if (platform === 'win32') return true
  return platform === 'linux' && !!env.APPIMAGE
}

function notify(body: string, onClick: () => void): void {
  if (!Notification.isSupported()) return
  const note = new Notification({ title: 'Switchboard', body })
  note.on('click', onClick)
  note.show()
}

// Ends the bridge before an update installs. The pid is read now, not when the update came:
// the bridge may have been restarted since and its old pid reused by another program.
export async function stopBridgeNow(
  bridgePid: () => Promise<number | null>,
  kill: (pid: number) => void = pid => process.kill(pid),
  waitMs = PID_WAIT_MS,
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>(resolve => (timer = setTimeout(() => resolve(null), waitMs)))
  const pid = await Promise.race([bridgePid().catch(() => null), late])
  clearTimeout(timer)
  if (pid === null || pid === process.pid) return null
  try {
    kill(pid)
  } catch {
    // Gone already.
  }
  return pid
}

// `bridgePid`: the pid of the bridge serving now (its /health). The bridge runs on this app's
// own executable, which Windows keeps locked while it runs, so a downloaded update stops it
// before installing.
export function startUpdates(bridgePid: () => Promise<number | null>): void {
  if (!app.isPackaged || process.env.CLAUDE_IDE_CAPTURE) return
  const { autoUpdater } = updater
  const installs = installsUpdates()
  autoUpdater.autoDownload = installs
  autoUpdater.autoInstallOnAppQuit = installs
  let told = ''
  autoUpdater.on('update-available', info => {
    if (installs || told === info.version) return
    told = info.version
    notify(t('update.available', { version: info.version }), () => void shell.openExternal(RELEASES_URL))
  })
  // Set once an update waits to install; the quit then stops the bridge first, once.
  let downloaded = false
  let stopped = false
  const stopBridge = async () => {
    stopped = true
    if (process.platform === 'win32') await stopBridgeNow(bridgePid)
  }
  autoUpdater.on('update-downloaded', info => {
    downloaded = true
    notify(t('update.ready', { version: info.version }), () => void stopBridge().finally(() => autoUpdater.quitAndInstall()))
  })
  app.on('before-quit', event => {
    if (!downloaded || stopped || process.platform !== 'win32') return
    // Held until the bridge is asked for its pid and stopped, then the quit carries on.
    event.preventDefault()
    void stopBridge().finally(() => app.quit())
  })
  autoUpdater.on('error', error => console.error('update check failed:', error.message))
  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined)
  check()
  setInterval(check, CHECK_MS).unref()
}
