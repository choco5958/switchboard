import { describe, expect, it } from 'vitest'
import { droppedText, dropPoint } from './termDrop'

describe('droppedText', () => {
  it('types plain paths as they are, with a space after', () => {
    expect(droppedText(['/Users/me/shot.png'], false)).toBe('/Users/me/shot.png ')
    expect(droppedText(['/a/b.txt', '/c/d-1_2.md'], false)).toBe('/a/b.txt /c/d-1_2.md ')
    expect(droppedText([], false)).toBe('')
  })

  it('escapes what the shell treats specially on macOS and Linux, and leaves other letters alone', () => {
    expect(droppedText(['/Users/me/Screen Shot (1).png'], false)).toBe('/Users/me/Screen\\ Shot\\ \\(1\\).png ')
    expect(droppedText(["/tmp/it's $HOME & `x`;*?.txt"], false)).toBe("/tmp/it\\'s\\ \\$HOME\\ \\&\\ \\`x\\`\\;\\*\\?.txt ")
    expect(droppedText(['/tmp/스크린샷 2026.png'], false)).toBe('/tmp/스크린샷\\ 2026.png ')
  })

  it('puts a path with a line break in single quotes, where the break survives', () => {
    expect(droppedText(["/tmp/a\nb's"], false)).toBe("'/tmp/a\nb'\\''s' ")
  })

  it('wraps a Windows path in double quotes only when it needs them', () => {
    expect(droppedText(['C:\\Users\\me\\shot.png'], true)).toBe('C:\\Users\\me\\shot.png ')
    expect(droppedText(['C:\\Users\\me\\My Pictures\\a (1).png', 'D:\\x.txt'], true)).toBe('"C:\\Users\\me\\My Pictures\\a (1).png" D:\\x.txt ')
  })
})

describe('dropPoint', () => {
  it('scales the point down only on Windows, where it comes in device pixels', () => {
    expect(dropPoint({ x: 400, y: 300 }, false, 2)).toEqual({ x: 400, y: 300 })
    expect(dropPoint({ x: 400, y: 300 }, true, 2)).toEqual({ x: 200, y: 150 })
    expect(dropPoint({ x: 400, y: 300 }, true, 0)).toEqual({ x: 400, y: 300 })
  })
})
