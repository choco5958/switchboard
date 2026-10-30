// Windows only (CI): the launch lines typed into a terminal's PowerShell 5.1 reach the CLI
// with the arguments meant, through an npm-style .cmd shim, even with spaces, backslashes and
// double quotes in them.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { PRESETS, presetLaunch } from '../shared/agents'
import { claudeLine } from './termAccount'
import { commandWord } from '../shared/agents'

const windows = process.platform === 'win32'
const dir = windows ? mkdtempSync(join(tmpdir(), 'sb-ps-')) : ''
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})
if (windows) {
  // Non-ASCII goes out as \u escapes, so the console code page cannot change it on the way.
  writeFileSync(
    join(dir, 'echoargs.js'),
    "process.stdout.write(JSON.stringify(process.argv.slice(2)).replace(/[\\u0080-\\uffff]/g, c => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')))",
  )
  writeFileSync(join(dir, 'fakecli.cmd'), '@node "%~dp0echoargs.js" %*\r\n')
}

const argsSeen = (line: string): string[] =>
  JSON.parse(
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', line], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` },
    }),
  ) as string[]

const server = {
  command: 'C:\\Users\\Jane Doe\\.claude-ide\\bin\\switchboard-node.cmd',
  args: ['C:\\Users\\Jane Doe\\.claude-ide\\runtime\\0.2.0\\mcp\\server.ts', '--agent', 'codex', '--terminal', 'k1-t1'],
}
const file = 'C:\\Users\\Jane Doe\\.claude-ide\\agents\\k1-t1.json'

for (const preset of PRESETS.filter(p => p.mcp)) {
  test.runIf(windows)(`${preset.id}: PowerShell hands the CLI the arguments meant`, () => {
    const meant = preset.mcp!(server, file).args ?? []
    const line = presetLaunch({ ...preset, bin: 'fakecli' }, server, file, 'win32').line
    expect(argsSeen(line)).toEqual(meant)
  })
}

test.runIf(windows)('a typographic single quote in a path stays in the argument and ends nothing', () => {
  const quoted = { ...server, args: ['C:\\Users\\Jane\u2019s PC\\mcp\\server.ts', '--x', "\u2018a'b\u201b"] }
  const preset = PRESETS.find(p => p.id === 'codex')!
  const meant = preset.mcp!(quoted, file).args ?? []
  expect(argsSeen(presetLaunch({ ...preset, bin: 'fakecli' }, quoted, file, 'win32').line)).toEqual(meant)
})

test.runIf(windows)('the Claude line finds the .cmd beside a .ps1 and keeps a folder with spaces as one word', () => {
  writeFileSync(join(dir, 'fakecli.ps1'), 'Write-Output "the ps1 ran"')
  const line = claudeLine(commandWord('fakecli', 'win32'), "'C:\\Users\\Jane Doe\\mod'", undefined, 4, false)
  expect(argsSeen(line)).toEqual(['--plugin-dir', 'C:\\Users\\Jane Doe\\mod'])
})
