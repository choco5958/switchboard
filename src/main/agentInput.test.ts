import { describe, expect, it } from 'vitest'
import { PASTE_END, PASTE_START, QUIET_MS, cleanText, cliInFront, pasteModeAfter, permissionMenu, readyToType, typedInput } from './agentInput'

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

  it("types nothing while the CLI's own confirmation menu is on screen", () => {
    const gemini = '\x1b[2K\x1b[1A Allow execution of: rm -rf build?\r\n\x1b[32m● 1. Yes, allow once\x1b[0m\r\n  2. Yes, allow always\r\n  3. No (esc)'
    const codex = '\x1b[12;3HAllow command?\x1b[13;3H\x1b[1m› 1. Yes, proceed\x1b[0m\x1b[14;3H  2. No, and tell Codex what to do'
    expect(permissionMenu(gemini)).toBe(true)
    expect(permissionMenu(codex)).toBe(true)
    expect(permissionMenu('Overwrite the file? [y/N] ')).toBe(true)
    // An answer with a numbered list, and a menu that more output has pushed up since.
    expect(permissionMenu('Next steps:\n1. Run the tests\n2. Yes, deploy it\n> ')).toBe(false)
    expect(permissionMenu(`${codex}\r\n${'done\r\n'.repeat(20)}> `)).toBe(false)
    const t = { alive: true, foreground: 'node', shell: '/bin/zsh', lastOutput: 0 }
    expect(readyToType({ ...t, screen: gemini }, 1e9)).toBe(false)
    expect(readyToType({ ...t, screen: 'gemini> ' }, 1e9)).toBe(true)
  })
})
