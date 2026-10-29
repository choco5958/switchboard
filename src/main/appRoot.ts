import { app } from 'electron'
import { join } from 'node:path'

// The folder holding bridge/, mcp/, mod/, scripts/ and src/shared/ as .ts files: the repo
// when run from it; in the installed app, Resources/node (electron-builder.yml
// extraResources) until the start copies it under ~/.claude-ide/runtime (src/main/runtime.ts).
let root = app.isPackaged ? join(process.resourcesPath, 'node') : app.getAppPath()

export function nodeRoot(): string {
  return root
}

export function useNodeRoot(path: string): void {
  root = path
}
