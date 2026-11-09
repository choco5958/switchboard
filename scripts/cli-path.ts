import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { npmShimScript } from '../src/main/agentDetect'

const WINDOWS = process.platform === 'win32'

// How a check starts a real CLI: the given command, the npm package's entry run with node (a
// Windows .cmd shim cannot start without a shell), or its name on PATH.
export function cliCommand(npm: string, bin: string, given: string[]): string[] {
  if (given.length > 0) return given
  const npmRoot = spawnSync(WINDOWS ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: WINDOWS }).stdout.trim()
  const pkg = join(npmRoot, ...npm.split('/'))
  if (existsSync(join(pkg, 'package.json'))) {
    const entry = (JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> }).bin
    const file = typeof entry === 'string' ? entry : entry?.[bin]
    if (file) {
      const path = join(pkg, file)
      // A package whose entry is the native program itself.
      const head = readFileSync(path).subarray(0, 2).toString()
      return head === '#!' || /\.[cm]?js$/.test(path) ? [process.execPath, path] : [path]
    }
  }
  if (WINDOWS) {
    const shim = spawnSync('where.exe', [`${bin}.cmd`], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0]?.trim()
    const script = shim ? npmShimScript(shim, readFileSync(shim, 'utf8')) : null
    if (script) return [process.execPath, script]
  }
  return [bin]
}
