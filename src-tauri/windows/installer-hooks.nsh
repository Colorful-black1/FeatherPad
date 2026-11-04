!include "${__FILEDIR__}\uninstall-data.nsh"

; The template can force-terminate a running editor even during silent installs.
; Refuse before any registry/data mutation and let FeatherPad flush normally.
!macro FeatherPadRequireClosed
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro RestartManager_StartSession $R0
    ${If} $R0 == ""
      SetErrorLevel 2
      Abort "无法确认轻羽运行状态，请关闭轻羽后重试。"
    ${EndIf}
    !insertmacro RestartManager_RegisterFile $R0 "$INSTDIR\${MAINBINARYNAME}.exe"
    ${If} $0 == 0
      StrCpy $1 0
      StrCpy $2 0
      System::Call 'RSTRTMGR::RmGetList(p R0, *i .r1, *i .r2, p 0, *i .r3) i .r0'
      StrCpy $R4 $0
    ${Else}
      StrCpy $R4 $0
    ${EndIf}
    !insertmacro RestartManager_EndSession $R0
    ${If} $R4 != 0
      IfSilent +2 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "轻羽仍在运行或运行状态未确认。请先保存或正常关闭所有轻羽窗口，然后重试；安装/卸载不会强制结束编辑器。"
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro FeatherPadRequireClosed
!macroend

!macro FeatherPadRemoveManagedKey KEY ICON
  ReadRegStr $0 HKCU "${KEY}" "FeatherPadManaged"
  ReadRegStr $1 HKCU "${KEY}\shell\open\command" ""
  ReadRegStr $2 HKCU "${KEY}\${ICON}" ""
  ${If} $0 == "app.featherpad.desktop"
  ${AndIf} $1 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
  ${AndIf} $2 == "$INSTDIR\${MAINBINARYNAME}.exe"
    DeleteRegKey HKCU "${KEY}"
    StrCpy $R5 1
  ${EndIf}
!macroend

!macro FeatherPadRemoveExtension EXT
  ${If} $R6 == 1
    ClearErrors
    ReadRegStr $0 HKCU "Software\Classes\${EXT}\OpenWithProgids" "FeatherPad.Text"
    ${IfNot} ${Errors}
    ${AndIf} $0 == ""
      DeleteRegValue HKCU "Software\Classes\${EXT}\OpenWithProgids" "FeatherPad.Text"
    ${EndIf}
  ${EndIf}
  !insertmacro FeatherPadRemoveMenu "Software\Classes\SystemFileAssociations\${EXT}\shell\FeatherPad"
!macroend

!macro FeatherPadRemoveMenu KEY
  ReadRegStr $0 HKCU "${KEY}" "FeatherPadManaged"
  ReadRegStr $1 HKCU "${KEY}\command" ""
  ReadRegStr $2 HKCU "${KEY}" "Icon"
  ${If} $0 == "app.featherpad.desktop"
  ${AndIf} $1 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
  ${AndIf} $2 == "$INSTDIR\${MAINBINARYNAME}.exe"
    DeleteRegKey HKCU "${KEY}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  IfSilent webview2_done
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ReadRegStr $1 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
  ${AndIf} $1 == ""
    MessageBox MB_OK|MB_ICONINFORMATION "轻羽 FeatherPad 需要 Microsoft Edge WebView2 Evergreen Runtime。$\r$\n$\r$\n程序已经安装，但缺少 Runtime 时不会启动。请连接网络并从 Microsoft 官方页面安装 Runtime，然后重新启动轻羽：$\r$\nhttps://developer.microsoft.com/microsoft-edge/webview2/#download-section$\r$\n$\r$\n安装程序不会自动下载或静默安装 Runtime。"
  ${EndIf}
  webview2_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro FeatherPadRequireClosed
  ${If} $UpdateMode <> 1
    StrCpy $R5 0
    !insertmacro FeatherPadRemoveManagedKey "Software\Classes\FeatherPad.Text" "DefaultIcon"
    StrCpy $R6 $R5
    !insertmacro FeatherPadRemoveManagedKey "Software\Classes\Applications\featherpad.exe" "DefaultIcon"
    !insertmacro FeatherPadRemoveExtension ".txt"
    !insertmacro FeatherPadRemoveExtension ".md"
    !insertmacro FeatherPadRemoveExtension ".markdown"
    !insertmacro FeatherPadRemoveExtension ".json"
    !insertmacro FeatherPadRemoveExtension ".jsonc"
    !insertmacro FeatherPadRemoveExtension ".yaml"
    !insertmacro FeatherPadRemoveExtension ".yml"
    !insertmacro FeatherPadRemoveExtension ".toml"
    !insertmacro FeatherPadRemoveExtension ".xml"
    !insertmacro FeatherPadRemoveExtension ".csv"
    !insertmacro FeatherPadRemoveExtension ".log"
    !insertmacro FeatherPadRemoveExtension ".ini"
    !insertmacro FeatherPadRemoveExtension ".conf"
    !insertmacro FeatherPadRemoveExtension ".sql"
    !insertmacro FeatherPadRemoveMenu "Software\Classes\Directory\shell\FeatherPad"
    System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0, p 0, p 0)'
    ${If} $DeleteAppDataCheckboxState == 1
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "清除轻羽本地数据会永久删除设置、会话和未保存内容的恢复副本。请先导出需要的内容。是否明确放弃这些恢复内容并清除？" /SD IDNO IDYES featherpad_clear_data
      Goto featherpad_keep_data
      featherpad_clear_data:
      StrCpy $FeatherPadCleanupFailed 0
      SetShellVarContext current
      Push "$LOCALAPPDATA\${BUNDLEID}"
      Call un.FeatherPadRemoveData
      ${If} $FeatherPadCleanupFailed == 1
        MessageBox MB_OK|MB_ICONEXCLAMATION "部分本地数据包含链接、被占用或无权访问，已保留。请核对恢复内容后手动处理。"
      ${EndIf}
      featherpad_keep_data:
    ${EndIf}
  ${EndIf}
  ; Disable the template's unrestricted recursive deletion, including on updates.
  StrCpy $DeleteAppDataCheckboxState 0
!macroend
