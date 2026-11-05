// Updates of the installed app: the part both shells share (docs/tauri-이전.md, step 7). Nothing
// here imports Electron. The Electron shell finds versions with electron-updater (updater.ts);
// the Tauri shell's Node host reads the release's update file itself (startHostUpdates). Either
// way a version counts only once its update file carries the release key's signature
// (updateSignature.ts), and on macOS both install it with the same download and swap
// (macUpdate.ts, macUpdates below), so an Electron app installs a Tauri bundle like any other.
// An update never stops the app by itself: it installs when the person quits, or when they ask
// for it from the notification after being told which terminals that closes.

import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { t } from '../shared/i18n'
import type { UpdateStatus } from '../shared/types'
import { nodeExecutable } from './appRoot'
import { appImageTarget, installerName, replaceAppImage, startWindowsInstall } from './installUpdate'
import { bundleOf, canReplace, cleanUpdates, download, isNewer, NeedsNewerSystem, releaseFile, releaseUrl, startSwap, unpack, zipFor, type ZipFile } from './macUpdate'
import { platform, type Ipc } from './platform'
import { channelFile, latestSigned, UpdateRefused, type SignedUpdate } from './updateSignature'

export const RELEASES_URL = 'https://github.com/choco5958/switchboard/releases/latest'
export const CHECK_MS = 6 * 3600_000

// How many terminals an install now would close: the quit ends every app terminal running in the
// app's own process, and with it Claude Code or whatever else runs there (terminals.ts
// terminalStates leaves out those the host keeps). None: nothing to ask.
export function terminalsClosing(terminals: readonly { alive: boolean }[]): number {
  return terminals.filter(one => one.alive).length
}

// Where the update stands, for the settings page; `watch` hears every change.
export function updateTracker(version: string) {
  let status: UpdateStatus = { version, state: 'off' }
  const listeners = new Set<(status: UpdateStatus) => void>()
  return {
    get: () => status,
    set(next: Partial<UpdateStatus>) {
      status = { ...status, ...next, version }
      for (const listener of listeners) listener(status)
    },
    watch(listener: (status: UpdateStatus) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export type Tracker = ReturnType<typeof updateTracker>

// A check now does nothing while one runs or a version is on its way or waiting to install.
export const checkable = (state: UpdateStatus['state']): boolean => !['off', 'checking', 'downloading', 'ready'].includes(state)

let tracked: Tracker | null = null
export const tracker = (): Tracker => (tracked ??= updateTracker(platform().version()))
// Set by the shell's updates: a check now, and the install of a version waiting for it.
let checkNow: () => void = () => undefined
let installReady: () => void = () => undefined
export const onCheckNow = (check: () => void) => void (checkNow = check)
export const onInstallReady = (install: () => void) => void (installReady = install)

// The settings page's view of it: the status, a check now, and the install of what waits.
export function registerUpdates(ipc: Pick<Ipc, 'handle'>, sendTo: (channel: string, payload: unknown) => void): void {
  tracker().watch(status => sendTo('update:status', status))
  ipc.handle('update:status', () => tracker().get())
  ipc.handle('update:check', () => {
    if (checkable(tracker().get().state)) checkNow()
    return tracker().get()
  })
  ipc.handle('update:install', () => {
    if (tracker().get().state === 'ready') installReady()
  })
}

export function notifyUpdate(body: string, onClick: () => void): void {
  if (platform().notificationsSupported()) platform().notify('Switchboard', body, onClick)
}

// Tells of a version this app cannot install itself: the notification opens the download page.
export function manualUpdates(status: Tracker): (version: string) => void {
  let told = ''
  return version => {
    status.set({ state: 'manual', latest: version, checkedAt: Date.now() })
    if (told === version) return
    told = version
    notifyUpdate(t('update.available', { version }), () => void platform().openExternal(RELEASES_URL))
  }
}

// Asked when the person clicks "ready" while app terminals run: installing now closes them, so
// the default keeps them and installs at the person's own quit.
export async function installNowAllowed(terminals: () => readonly { alive: boolean }[], version: string): Promise<boolean> {
  const count = terminalsClosing(terminals())
  if (count === 0) return true
  const answer = await platform().messageBox({
    type: 'question',
    buttons: [t('update.installNow'), t('update.installOnQuit')],
    defaultId: 1,
    cancelId: 1,
    message: t('update.confirmMessage', { version }),
    detail: t('update.confirmDetail', { count }),
  })
  return answer === 0
}

// The running app, for the swap: its executable (inside the bundle to replace), the process the
// swap waits for, and the hook that starts the swap once the app is going away. `arch`: the
// machine's own, when it differs from the process's (process.arch): an x64 build emulated on ARM64
// Windows, which the Electron app's update brings there, then updates to the ARM64 build.
export type AppPlace = { exe: string; pid: number; whenQuit: (start: () => void) => void; arch?: string }

// How one system gets a version into place: the file to download for it (null: this copy cannot
// install that version), whether this copy can install at all, the download staged for the install,
// and the install itself, run as the app quits.
type Steps<S> = {
  file(found: SignedUpdate): ZipFile | null
  canInstall(): boolean
  stage(file: ZipFile, version: string): Promise<S>
  discard(staged: S): void
  install(staged: S, relaunch: boolean): void
}

// Returns what to do with a version found, given its signed update file (updateSignature.ts),
// whose sha512 the download has to match. Resolves true when it is downloaded or on its way, false
// when the person has to download it themselves. `failed`: versions whose install failed before,
// offered as a download instead.
export function stagedUpdates<S>(terminals: () => readonly { alive: boolean }[], status: Tracker, place: AppPlace, failed: Set<string>, steps: Steps<S>): (found: SignedUpdate) => Promise<boolean> {
  let staged: { version: string; it: S } | null = null
  let busy = ''
  let relaunch = false
  let installed = false
  // A shutdown or logout quits the app too, but the system may stop the install halfway; that
  // update waits for the next quit.
  let shuttingDown = false
  platform().onPower('shutdown', () => (shuttingDown = true))
  place.whenQuit(() => {
    if (!staged || installed) return
    if (shuttingDown || !steps.canInstall()) {
      console.error(`update ${staged.version} waits: ${shuttingDown ? 'the system is shutting down' : 'this copy cannot be replaced now'}`)
      return
    }
    installed = true
    console.error(`update ${staged.version}: installing as the app quits${relaunch ? ', then starting it again' : ''}`)
    try {
      steps.install(staged.it, relaunch)
    } catch (error) {
      console.error('could not start the update:', error)
    }
  })
  const installNow = (version: string) =>
    void installNowAllowed(terminals, version).then(now => {
      if (!now) return
      relaunch = true
      platform().quit()
    })
  return async found => {
    const { version } = found
    if (!isNewer(version, platform().version())) {
      status.set({ state: 'latest', latest: undefined, checkedAt: Date.now() })
      return true
    }
    if (staged?.version === version || busy === version) return true
    const file = steps.file(found)
    if (!file || failed.has(version) || !steps.canInstall()) return false
    busy = version
    status.set({ state: 'downloading', latest: version, checkedAt: Date.now() })
    try {
      // A quit while this downloads installs what was staged before, if anything.
      const it = await steps.stage(file, version)
      console.error(`update ${version}: ${file.name} downloaded`)
      const before = staged
      staged = { version, it }
      if (before) steps.discard(before.it)
      onInstallReady(() => installNow(version))
      status.set({ state: 'ready', latest: version })
      notifyUpdate(t('update.ready', { version }), () => installNow(version))
      return true
    } catch (error) {
      console.error('update download failed:', error instanceof Error ? error.message : error)
      if (error instanceof NeedsNewerSystem) failed.add(version)
      // A version staged before still waits to install; otherwise the person downloads it.
      if (!staged) return false
      status.set({ state: 'ready', latest: staged.version })
      return true
    } finally {
      busy = ''
    }
  }
}

// macOS: the release's zip for this chip, unpacked beside the app's data and swapped in for the
// bundle by a script once the app has quit (macUpdate.ts).
// The bridge keeps running through the swap. It runs the app's Node (Electron's executable as
// Node, or the Tauri app's switchboard-node), but macOS keeps a moved or deleted file open for the
// process using it, and its scripts are a copy under ~/.claude-ide/runtime (runtime.ts). The new
// version replaces it when it starts (staleBridge). The terminal host does the same and is not
// replaced: it keeps its terminals until they end.
export function macUpdates(terminals: () => readonly { alive: boolean }[], status: Tracker, place: AppPlace): (found: SignedUpdate) => Promise<boolean> {
  const bundle = bundleOf(place.exe)
  const dir = join(platform().userDataPath(), 'updates')
  const log = join(platform().userDataPath(), 'update.log')
  return stagedUpdates(terminals, status, place, cleanUpdates(dir, platform().version()), {
    file: found => zipFor(found.files, found.version, process.arch),
    canInstall: () => !!bundle && canReplace(bundle),
    stage: async (file, version) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const zip = join(dir, file.name)
      const stage = join(dir, version)
      await download(releaseUrl(version, file.name), zip, file)
      const fresh = await unpack(zip, stage, version).finally(() => rmSync(zip, { force: true }))
      return { fresh, stage }
    },
    discard: ({ stage }) => rmSync(stage, { recursive: true, force: true }),
    install: ({ fresh, stage }, relaunch) => startSwap({ pid: place.pid, target: bundle!, fresh, stage, relaunch, log }),
  })
}

// Windows and a Linux AppImage (installUpdate.ts); null where this copy installs nothing itself (a
// .deb, another system), and the person is told where to download the new version.
export function installerUpdates(terminals: () => readonly { alive: boolean }[], status: Tracker, place: AppPlace, env: Record<string, string | undefined> = process.env): ((found: SignedUpdate) => Promise<boolean>) | null {
  const dir = join(platform().userDataPath(), 'updates')
  const log = join(platform().userDataPath(), 'update.log')
  const file = (found: SignedUpdate) => {
    const name = installerName(found.version, process.platform, place.arch ?? process.arch)
    return name ? releaseFile(found.files, found.version, name) : null
  }
  if (process.platform === 'win32') {
    return stagedUpdates(terminals, status, place, cleanUpdates(dir, platform().version()), {
      file,
      canInstall: () => true,
      stage: async (found, version) => {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        const installer = join(dir, found.name)
        await download(releaseUrl(version, found.name), installer, found)
        return { installer, version }
      },
      discard: ({ installer }) => rmSync(installer, { force: true }),
      install: ({ installer, version }, relaunch) => startWindowsInstall({ pid: place.pid, installer, relaunch, app: place.exe, log, failedMark: join(dir, `${version}.failed`), node: nodeExecutable().path }),
    })
  }
  const target = process.platform === 'linux' ? appImageTarget(env) : null
  if (!target) return null
  // Beside the AppImage, hidden; a download an earlier run left there goes first.
  const fresh = join(dirname(target), '.switchboard-update.AppImage')
  rmSync(fresh, { force: true })
  return stagedUpdates(terminals, status, place, new Set(), {
    file,
    canInstall: () => appImageTarget(env) !== null,
    stage: async (found, version) => {
      await download(releaseUrl(version, found.name), fresh, found)
      return fresh
    },
    discard: () => undefined,
    install: (path, relaunch) => replaceAppImage({ pid: place.pid, target, fresh: path, relaunch }),
  })
}

// The Tauri shell's updates, run by its Node host (src/host/main.ts): every few hours, and when
// the settings page asks, the latest release's signed update file for this system. macOS, Windows
// and an AppImage install it (macUpdates, installerUpdates); any other copy is told where to
// download it.
export function startHostUpdates(place: AppPlace, terminals: () => readonly { alive: boolean }[], latest: (file: string) => Promise<SignedUpdate> = latestSigned): void {
  const status = tracker()
  status.set({ state: 'idle' })
  const install = process.platform === 'darwin' ? macUpdates(terminals, status, place) : installerUpdates(terminals, status, place)
  const tellAvailable = manualUpdates(status)
  let running = false
  const check = async () => {
    if (running) return
    running = true
    if (checkable(status.get().state)) status.set({ state: 'checking', error: undefined })
    try {
      const update = await latest(channelFile())
      if (!isNewer(update.version, platform().version())) {
        if (status.get().state === 'checking') status.set({ state: 'latest', latest: undefined, checkedAt: Date.now() })
      } else if (install) {
        if (!(await install(update))) tellAvailable(update.version)
      } else tellAvailable(update.version)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(error instanceof UpdateRefused ? 'update refused:' : 'update check failed:', message)
      if (status.get().state === 'checking') {
        status.set(error instanceof UpdateRefused ? { state: 'refused', latest: error.version, checkedAt: Date.now() } : { state: 'error', error: message, checkedAt: Date.now() })
      }
    } finally {
      running = false
    }
  }
  onCheckNow(() => void check())
  void check()
  setInterval(() => void check(), CHECK_MS).unref()
}
