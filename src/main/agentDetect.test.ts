import { describe, expect, it } from 'vitest'
import { npmShimScript } from './agentDetect'

describe('npm shims on Windows', () => {
  it('finds the script behind a .cmd that npm wrote', () => {
    // As npm 10 (cmd-shim) writes one for a package's bin.
    const shim = [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      '',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%',
      ')',
      '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js" %*',
    ].join('\r\n')
    expect(npmShimScript('C:\\Users\\Dae Hyeon\\AppData\\Roaming\\npm\\gemini.cmd', shim)).toBe(
      'C:\\Users\\Dae Hyeon\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js',
    )
    expect(npmShimScript('C:\\npm\\x.cmd', '@echo off\r\nx.exe %*')).toBeNull()
  })
})
