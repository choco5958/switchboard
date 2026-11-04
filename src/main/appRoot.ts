import { platform } from './platform'
import { join } from 'node:path'

// The folder holding bridge/, mcp/, mod/, scripts/ and src/shared/ as .ts files: the repo
// when run from it; in the installed app, Resources/node (electron-builder.yml
// extraResources) until the start copies it under ~/.claude-ide/runtime (src/main/runtime.ts).
// Set once the shell's platform is known (platform.ts), on first use.
let root: string | null = null

export function nodeRoot(): string {
  root ??= platform().isPackaged ? join(platform().resourcesPath(), 'node') : platform().appPath()
  return root
}

export function useNodeRoot(path: string): void {
  root = path
}

// What runs the Node side (the bridge, the terminal host, the launchers of runtime.ts). The
// Electron app: its own executable in Node mode, or, in an AppImage, the AppImage file, as the
// mount it runs from goes with the app. The Tauri app: its own Node, switchboard-node, which on
// Windows and Linux the start copies beside the runtime copy of Resources/node (runtime.ts
// copyNode), so an update can replace the installed one while the bridge runs (Windows locks a
// running executable) and an AppImage's mount can go. `appImage`: the executable is an AppImage,
// whose launcher takes arguments of its own.
let node: { path: string; appImage: boolean } | null = null

export function nodeExecutable(): { path: string; appImage: boolean } {
  if (node) return node
  if (process.versions.electron && process.env.APPIMAGE) return { path: process.env.APPIMAGE, appImage: true }
  return { path: process.execPath, appImage: false }
}

export function useNodeExecutable(path: string): void {
  node = { path, appImage: false }
}
