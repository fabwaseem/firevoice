; FireVoice additions to the Tauri NSIS installer (bundle.windows.nsis.installerHooks in tauri.conf.json).
;
; "Delete all FireVoice data" in the uninstaller removes, besides the app's own folders (which Tauri already deletes),
; FireVoice's data: voices, history, projects, renders, engines and models. The app records where those live in
; data-folders.txt (src-tauri/src/datafolders.rs); ~/.firevoice is removed even without that list.
; Never during an update (/UPDATE) and never in a silent uninstall, where the box is not shown.

; the default data folder (a test build can point it elsewhere)
!ifndef FV_DEFAULT_DATA
  !define FV_DEFAULT_DATA "$PROFILE\.firevoice"
!endif

!macro NSIS_HOOK_PREUNINSTALL
  ; keep the list: Tauri deletes the folder it lives in before the post-uninstall hook runs
  InitPluginsDir
  SetShellVarContext current
  CopyFiles /SILENT "$LOCALAPPDATA\${BUNDLEID}\data-folders.txt" "$PLUGINSDIR\fv-data-folders.txt"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    ClearErrors
    FileOpen $R0 "$PLUGINSDIR\fv-data-folders.txt" r
    ${IfNot} ${Errors}
      ${Do}
        ClearErrors
        FileRead $R0 $R1
        ${If} ${Errors}
          ${Break}
        ${EndIf}
        ; drop the line ending
        StrCpy $R2 $R1 1 -1
        ${If} $R2 == "$\n"
          StrCpy $R1 $R1 -1
        ${EndIf}
        StrCpy $R2 $R1 1 -1
        ${If} $R2 == "$\r"
          StrCpy $R1 $R1 -1
        ${EndIf}
        StrLen $R3 $R1
        ${If} $R3 > 5
          DetailPrint "Deleting FireVoice data: $R1"
          RMDir /r "$R1"
        ${EndIf}
      ${Loop}
      FileClose $R0
    ${EndIf}
    ; the default data folder, in case the app never wrote its list
    ${If} ${FileExists} "${FV_DEFAULT_DATA}\*.*"
      DetailPrint "Deleting FireVoice data: ${FV_DEFAULT_DATA}"
      RMDir /r "${FV_DEFAULT_DATA}"
    ${EndIf}
  ${EndIf}
!macroend
