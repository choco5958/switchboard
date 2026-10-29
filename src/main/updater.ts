// Updates of the installed app, from the GitHub releases (electron-builder.yml publish).
// Windows and Linux download a new version and install it when the app quits. macOS
// installs only a signed update, and this app is not signed: there the person gets a
// notification that opens the download page.

import { app, Notification, shell } from 'electron'
import updater from 'electron-updater'
import { t } from '../shared/i18n'

export const RELEASES_URL = 'https://github.com/choco5958/switchboard/releases/latest'
const CHECK_MS = 6 * 3600_000

function notify(body: string, onClick: () => void): void {
  if (!Notification.isSupported()) return
  const note = new Notification({ title: 'Switchboard', body })
  note.on('click', onClick)
  note.show()
}

export function startUpdates(): void {
  if (!app.isPackaged || process.env.CLAUDE_IDE_CAPTURE) return
  const { autoUpdater } = updater
  const installs = process.platform !== 'darwin'
  autoUpdater.autoDownload = installs
  autoUpdater.autoInstallOnAppQuit = installs
  let told = ''
  autoUpdater.on('update-available', info => {
    if (installs || told === info.version) return
    told = info.version
    notify(t('update.available', { version: info.version }), () => void shell.openExternal(RELEASES_URL))
  })
  autoUpdater.on('update-downloaded', info => {
    notify(t('update.ready', { version: info.version }), () => autoUpdater.quitAndInstall())
  })
  autoUpdater.on('error', error => console.error('update check failed:', error.message))
  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined)
  check()
  setInterval(check, CHECK_MS).unref()
}
