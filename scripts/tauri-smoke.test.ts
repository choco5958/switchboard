import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SHELL_WORDS, pageScript } from './tauri-smoke.ts'

const words = new Function(`return ${SHELL_WORDS}`)() as (text: string) => string

test('a terminal that only set up its screen and title has said nothing yet', () => {
  // What the Windows ARM runner's terminal held after 46 seconds (release v0.3.34): the shell had not started.
  const setup = '\u001b[?9001h\u001b[?1004h\u001b[?25l\u001b[2J\u001b[m\u001b[H\u001b]0;Administrator: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\u0007\u001b[?25h'
  assert.equal(words(setup), '')
  assert.equal(words(''), '')
  // A title ended the other way (ESC \), and a lone escape.
  assert.equal(words('\u001b]2;zsh\u001b\\\u001b=\r\n'), '')
})

test('a banner or a prompt is the shell speaking', () => {
  assert.equal(words('\u001b[?25l\u001b[2J\u001b[HWindows PowerShell\r\nCopyright (C) Microsoft Corporation.'), 'Windows PowerShell\r\nCopyright (C) Microsoft Corporation.')
  assert.equal(words('\u001b]0;pwsh\u0007PS C:\\work> '), 'PS C:\\work>')
  assert.equal(words('\u001b[1m\u001b[7m%\u001b[27m\u001b[1m\u001b[0m   \r \r\u001b[0m\u001b[27m\u001b[24m\u001b[Jrunner@mac scratch % \u001b[K\u001b[?2004h'), '%   \r \rrunner@mac scratch %')
  assert.equal(words('bash-3.2$ '), 'bash-3.2$')
})

test('the page script is one expression that parses', () => {
  const script = pageScript('C:\\Users\\runner\\scratch', 'http://127.0.0.1:1/')
  assert.doesNotThrow(() => new Function(`return ${script}`))
  assert.match(script, /words\(await output\(\)\)\.length > 0, 90000/)
})
