import { describe, expect, it } from 'vitest'
import { PASTE_END, PASTE_START, QUIET_MS, cleanText, cliInFront, pasteModeAfter, permissionMenu, readyToType, typedInput, typingBlock } from './agentInput'
import { createScreen, settled } from './termScreen'

const answer = '[Switchboard] Q7 답이 왔습니다.\n질문: 어디에 둘까\n고른 것: (a) 카드 안\n이 답에 따라 멈춰 있던 작업을 이어서 진행하세요.'

describe('typing an answer', () => {
  it('goes in as one bracketed paste with its lines, Enter left for later', () => {
    const typed = typedInput(answer, true)
    expect(typed).toBe(`${PASTE_START}${answer}${PASTE_END}`)
    expect(typed).not.toContain('\r')
  })

  it('without bracketed paste the lines are joined, so no newline submits early', () => {
    expect(typedInput('a\n\n---\n\nb\nc', false)).toBe('a --- b c')
  })

  it('an escape inside the text cannot end the paste or send keys', () => {
    const typed = typedInput(`메모 \x1b[201~rm -rf ~\r\x03 끝`, true)
    expect(typed.slice(PASTE_START.length, -PASTE_END.length)).toBe('메모 [201~rm -rf ~\n 끝')
    expect(cleanText('a\r\nb\tc')).toBe('a\nb\tc')
  })

  it('bracketed paste follows the last mode switch the CLI printed', () => {
    expect(pasteModeAfter(false, 'x\x1b[?2004hy')).toBe(true)
    expect(pasteModeAfter(true, '\x1b[?2004h...\x1b[?2004l')).toBe(false)
    expect(pasteModeAfter(true, 'plain output')).toBe(true)
  })

  it('types only while the CLI, not the shell, is in front and the screen has been quiet', () => {
    expect(cliInFront('node', '/bin/zsh')).toBe(true)
    expect(cliInFront('codex', '/bin/zsh')).toBe(true)
    expect(cliInFront('zsh', '/bin/zsh')).toBe(false)
    expect(cliInFront('-zsh', '/bin/zsh')).toBe(false)
    expect(cliInFront('bash', '/bin/zsh')).toBe(false)
    expect(cliInFront('', '/bin/zsh')).toBe(false)
    const t = { alive: true, foreground: 'node', shell: '/bin/zsh', lastOutput: 1000 }
    expect(readyToType(t, 1000 + QUIET_MS)).toBe(true)
    expect(readyToType(t, 1000 + QUIET_MS - 1)).toBe(false)
    expect(readyToType({ ...t, alive: false }, 1e9)).toBe(false)
  })

  // Drawn on a headless terminal, as the app sees the screen (termScreen.ts).
  const shown = async (output: string, cols = 60, rows = 16) => {
    const screen = createScreen(cols, rows)
    await settled(screen, output)
    const lines = screen.rows()
    screen.dispose()
    return lines
  }

  it("types nothing while the CLI's own confirmation menu is on screen", async () => {
    const gemini = ' Allow execution of: rm -rf build?\r\n\x1b[32m● 1. Yes, allow once\x1b[0m\r\n  2. Yes, allow always\r\n  3. No (esc)'
    // Codex draws with cursor moves, the marker and the option in separate writes.
    const codex = '\x1b[2;3HAllow command?\x1b[4;3H\x1b[1m›\x1b[4;5H1. Yes, proceed\x1b[0m\x1b[5;5H2. No, and tell Codex what to do'
    const claude = 'Do you want to proceed?\r\n❯ 1. Yes\r\n  2. Yes, and don\'t ask again\r\n  3. No'
    expect(permissionMenu(await shown(gemini))).toBe(true)
    expect(permissionMenu(await shown(codex))).toBe(true)
    expect(permissionMenu(await shown(claude))).toBe(true)
    expect(permissionMenu(await shown('Overwrite the file? [y/N] '))).toBe(true)
    const t = { alive: true, foreground: 'node', shell: '/bin/zsh', lastOutput: 0 }
    expect(typingBlock({ ...t, screen: await shown(gemini) }, 1e9)).toBe('menu')
    expect(typingBlock({ ...t, screen: await shown('gemini> ') }, 1e9)).toBe(null)
    expect(readyToType({ ...t, lastOutput: 1e9 - 10 }, 1e9)).toBe(false)
  })

  it('an idle screen with the person\'s own words, a quote or an answered menu is not a menu', async () => {
    // The person's reply in the history, their draft in the prompt box, quotes in an answer.
    expect(permissionMenu(await shown('> yes, go ahead\r\n\r\nDone.\r\n╭──────╮\r\n│ >    │\r\n╰──────╯'))).toBe(false)
    expect(permissionMenu(await shown('│ > no, use the other branch │'))).toBe(false)
    expect(permissionMenu(await shown('Summary\r\n> No changes detected\r\nContinue? [y/N] was the old prompt\r\n> '))).toBe(false)
    expect(permissionMenu(await shown('Next steps:\r\n1. Run the tests\r\n2. Yes, deploy it\r\n> '))).toBe(false)
    // A menu answered with "No": Ink erases its lines and draws the prompt in their place.
    const menu = 'Allow execution?\r\n● 1. Yes\r\n  2. No'
    expect(permissionMenu(await shown(`${menu}\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\r> `))).toBe(false)
  })
})
