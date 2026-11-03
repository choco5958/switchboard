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
