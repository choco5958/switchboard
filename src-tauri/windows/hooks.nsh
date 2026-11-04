; The Tauri app's installer on Windows (tauri.conf.json bundle.windows.nsis.installerHooks), in
; place of the Electron app's (docs/tauri-이전.md, step 8). The installed Electron app updates to
; this one by running it as electron-updater runs any update: --updated /S, and --force-run when
; the app is to start again afterwards.

; Where electron-builder registered the Electron app for this user: its uninstall key is the UUID
; v5 of the app id (io.github.choco5958.switchboard) in electron-builder's namespace.
!define ELECTRON_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ea94edae-7cd8-5e0c-9fa2-3791d8ac7a6b"

; Removes the Electron app first, with its own uninstaller: its files, its Start menu and desktop
; shortcuts (named as this app's are, which come after) and its entry in Installed apps. The data
; folder stays (%APPDATA%\claude-ide, which this app goes on using). An install for every user
; (HKLM) needs an administrator and is left for the person to remove.
!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R9 HKCU "${ELECTRON_UNINSTALL_KEY}" "QuietUninstallString"
  ${If} $R9 != ""
    DetailPrint "Removing the earlier Switchboard"
    ExecWait $R9
    ; The uninstaller copies itself away and returns at once: wait for its entry to go.
    StrCpy $R8 0
    ${Do}
      ReadRegStr $R9 HKCU "${ELECTRON_UNINSTALL_KEY}" "QuietUninstallString"
      ${If} $R9 == ""
      ${OrIf} $R8 >= 120
        ${Break}
      ${EndIf}
      Sleep 500
      IntOp $R8 $R8 + 1
    ${Loop}
  ${EndIf}
!macroend

; electron-updater asks the update to start the app again with --force-run (this installer's own
; switch for that is /R).
!macro NSIS_HOOK_POSTINSTALL
  ${GetOptions} $CMDLINE "--force-run" $R9
  ${IfNot} ${Errors}
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
  ${EndIf}
!macroend
