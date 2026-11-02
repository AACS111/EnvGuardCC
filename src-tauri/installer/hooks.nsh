; electron-builder derives this GUID from the unchanged application identifier.
; UUID v5(appId, 50e065bc-3134-11e6-9bab-38c9862bdaf3), electron-builder 26.
!define LEGACY_APP_GUID "a59cf393-cb32-55c4-b272-b654f2337b89"

; PROCESSENTRY32W layout follows the installer process's pointer width.
!if ${NSIS_PTR_SIZE} > 4
  !define ENVGUARD_PROCESS_ENTRY_SIZE 568
  !define ENVGUARD_PROCESS_EXE_OFFSET 44
!else
  !define ENVGUARD_PROCESS_ENTRY_SIZE 556
  !define ENVGUARD_PROCESS_EXE_OFFSET 36
!endif

; Both hooks run before Tauri's default Restart Manager check, which can force-kill apps.
!macro ENVGUARD_REQUIRE_EXIT
  ; Enumerate Windows processes directly: no console capture, localized tasklist
  ; output, or shared scratch-register contents participate in this decision.
  System::Store "s"
  StrCpy $R5 -1
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p.R0'
  ${If} $R0 != -1
  ${AndIf} $R0 != 4294967295
  ${AndIf} $R0 != 0
    System::Alloc ${ENVGUARD_PROCESS_ENTRY_SIZE}
    Pop $R1
    ${If} $R1 != 0
      System::Call '*$R1(i ${ENVGUARD_PROCESS_ENTRY_SIZE})'
      System::Call 'kernel32::Process32FirstW(p R0, p R1) i.R2 ?e'
      Pop $R6
      ${If} $R2 != 0
        StrCpy $R5 0
        ${Do}
          System::Int64Op $R1 + ${ENVGUARD_PROCESS_EXE_OFFSET}
          Pop $R4
          System::Call '*$R4(&w260 .R3)'
          System::Call 'kernel32::lstrcmpiW(w R3, w "EnvGuardCC.exe") i.R4'
          ${If} $R4 == 0
            StrCpy $R5 1
            ${Break}
          ${EndIf}
          System::Call 'kernel32::Process32NextW(p R0, p R1) i.R2 ?e'
          Pop $R6
        ${LoopWhile} $R2 != 0
        ${If} $R5 == 0
        ${AndIf} $R6 != 18
          StrCpy $R5 -1
        ${EndIf}
      ${EndIf}
      System::Free $R1
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p R0)'
  ${EndIf}
  ${If} $R5 == -1
    System::Store "l"
    MessageBox MB_OK|MB_ICONEXCLAMATION "无法确认 EnvGuardCC 运行状态，请先退出应用后重试。" /SD IDOK
    SetErrorLevel 1
    Abort
  ${ElseIf} $R5 == 1
    System::Store "l"
    MessageBox MB_OK|MB_ICONEXCLAMATION "请先从托盘退出 EnvGuardCC，等待配置恢复完成后重新安装或卸载。" /SD IDOK
    SetErrorLevel 1
    Abort
  ${Else}
    System::Store "l"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro ENVGUARD_REQUIRE_EXIT
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ENVGUARD_REQUIRE_EXIT
  ReadRegStr $R3 HKCU "Software\${LEGACY_APP_GUID}" "InstallLocation"
  ${If} $R3 != ""
    MessageBox MB_OKCANCEL|MB_ICONINFORMATION "检测到 Electron 旧版，将在原目录升级：$R3。请先从托盘退出旧版并等待配置恢复。" /SD IDOK IDOK +2
    Abort
    StrCpy $INSTDIR $R3
    SetOutPath $INSTDIR
  ${EndIf}
  ; Clean only known Electron files in a verified legacy installation.
  ${If} $R3 != ""
  ${AndIf} ${FileExists} "$INSTDIR\resources\app\package.json"
  ${AndIf} ${FileExists} "$INSTDIR\chrome_100_percent.pak"
    Delete "$INSTDIR\chrome_100_percent.pak"
    Delete "$INSTDIR\chrome_200_percent.pak"
    Delete "$INSTDIR\ffmpeg.dll"
    Delete "$INSTDIR\d3dcompiler_47.dll"
    Delete "$INSTDIR\dxcompiler.dll"
    Delete "$INSTDIR\dxil.dll"
    Delete "$INSTDIR\icudtl.dat"
    Delete "$INSTDIR\libEGL.dll"
    Delete "$INSTDIR\libGLESv2.dll"
    Delete "$INSTDIR\resources.pak"
    Delete "$INSTDIR\snapshot_blob.bin"
    Delete "$INSTDIR\v8_context_snapshot.bin"
    Delete "$INSTDIR\vk_swiftshader.dll"
    Delete "$INSTDIR\vk_swiftshader_icd.json"
    Delete "$INSTDIR\vulkan-1.dll"
    Delete "$INSTDIR\LICENSE.electron.txt"
    Delete "$INSTDIR\LICENSES.chromium.html"
    Delete "$INSTDIR\version"
    RMDir /r "$INSTDIR\resources\app"
    RMDir /r "$INSTDIR\locales"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; The new uninstaller owns the replaced installation; preserve all user data.
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${LEGACY_APP_GUID}"
  DeleteRegKey HKCU "Software\${LEGACY_APP_GUID}"
  Delete "$INSTDIR\Uninstall EnvGuardCC.exe"
!macroend
