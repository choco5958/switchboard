import { expect, test } from 'vitest'
import { parseDetect } from './agentDetect'
import { cliInFront } from './agentInput'
import { isAbsolutePath, loginShell, whereScript } from './shell'

test('a login shell on macOS and Linux, PowerShell on Windows', () => {
  expect(loginShell({ SHELL: '/bin/bash' }, 'linux')).toMatchObject({ file: '/bin/bash', interactive: ['-l', '-i'] })
  expect(loginShell({}, 'darwin').command('pnpm dev')).toEqual(['-l', '-c', 'pnpm dev'])
  const windows = loginShell({ SHELL: '/bin/bash' }, 'win32')
  expect(windows.file).toBe('powershell.exe')
  expect(windows.command('pnpm dev')).toEqual(['-NoLogo', '-NoProfile', '-Command', 'pnpm dev'])
})

test('where each CLI is, from either shell, keeps absolute paths only', () => {
  expect(whereScript(['node', 'codex'], '@', 'win32')).toContain("foreach ($c in 'node','codex')")
  expect(whereScript(['node'], '@', 'darwin')).toContain('command -v')
  expect(isAbsolutePath('C:\\Program Files\\nodejs\\node.exe')).toBe(true)
  expect(isAbsolutePath('alias codex=...')).toBe(false)
  expect(parseDetect('__switchboard__node=C:\\Program Files\\nodejs\\node.exe\r\n__switchboard__codex=\r\n')).toEqual({ node: 'C:\\Program Files\\nodejs\\node.exe' })
})

test('PowerShell in front of a terminal counts as the shell, not a CLI', () => {
  expect(cliInFront('powershell.exe', 'powershell.exe')).toBe(false)
  expect(cliInFront('C:\\Windows\\System32\\cmd.exe', 'powershell.exe')).toBe(false)
  expect(cliInFront('node.exe', 'powershell.exe')).toBe(true)
})

test('answers go only to the CLI the terminal started, not to ssh or python started after it', () => {
  expect(cliInFront('codex', '/bin/zsh', ['codex', 'node'])).toBe(true)
  expect(cliInFront('node', '/bin/zsh', ['codex', 'node'])).toBe(true)
  expect(cliInFront('ssh', '/bin/zsh', ['codex', 'node'])).toBe(false)
  expect(cliInFront('python3', '/bin/zsh', ['codex', 'node'])).toBe(false)
  expect(cliInFront('codex.exe', 'powershell.exe', ['codex', 'node'])).toBe(true)
})
