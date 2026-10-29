// The shell the app's terminals and its one-line commands run in: the person's login shell
// on macOS and Linux (an app started from Finder has no PATH of its own), PowerShell on
// Windows.

type Env = Record<string, string | undefined>

export type Shell = { file: string; interactive: string[]; command: (line: string) => string[] }

export function loginShell(env: Env = process.env, platform: string = process.platform): Shell {
  if (platform === 'win32') {
    return { file: 'powershell.exe', interactive: ['-NoLogo'], command: line => ['-NoLogo', '-NoProfile', '-Command', line] }
  }
  return { file: env.SHELL || '/bin/zsh', interactive: ['-l', '-i'], command: line => ['-l', '-c', line] }
}

// The command that prints where each CLI is, one `<mark><bin>=<path>` line per CLI.
export function whereScript(bins: readonly string[], mark: string, platform: string = process.platform): string {
  if (platform === 'win32') {
    const list = bins.map(b => `'${b}'`).join(',')
    return `foreach ($c in ${list}) { $p = (Get-Command $c -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source; Write-Output "${mark}$c=$p" }`
  }
  return `for c in ${bins.join(' ')}; do printf '${mark}%s=%s\\n' "$c" "$(command -v "$c" 2>/dev/null)"; done`
}

// A path a lookup printed: absolute on either system. An alias or a function prints its definition.
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

// The process names that mean the shell itself is in front of a terminal again.
export const SHELL_NAMES = ['login', 'sh', 'bash', 'zsh', 'fish', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'cmd', 'cmd.exe']
