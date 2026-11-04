!ifndef FEATHERPAD_UNINSTALL_DATA
!define FEATHERPAD_UNINSTALL_DATA

Var FeatherPadCleanupFailed

; The caller supplies only the product data root. Never recurse through reparse
; points; retain them and report incomplete cleanup instead of touching targets.
Function un.FeatherPadRemoveData
  Exch $0
  Push $1
  Push $2
  Push $3
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
  ${If} $1 == -1
    System::Call 'kernel32::GetLastError() i.r2'
    ${If} $2 != 2
    ${AndIf} $2 != 3
      StrCpy $FeatherPadCleanupFailed 1
    ${EndIf}
    Goto data_done
  ${EndIf}
  IntOp $2 $1 & 0x400
  ${If} $2 != 0
    StrCpy $FeatherPadCleanupFailed 1
    Goto data_done
  ${EndIf}
  IntOp $2 $1 & 0x10
  ${If} $2 != 0
    FindFirst $1 $2 "$0\*"
    data_next:
      ${If} $2 == ""
        Goto data_close
      ${EndIf}
      ${If} $2 != "."
      ${AndIf} $2 != ".."
        Push "$0\$2"
        Call un.FeatherPadRemoveData
      ${EndIf}
      FindNext $1 $2
      Goto data_next
    data_close:
    FindClose $1
    ClearErrors
    RMDir "$0"
  ${Else}
    ClearErrors
    Delete "$0"
  ${EndIf}
  ${If} ${Errors}
    StrCpy $FeatherPadCleanupFailed 1
  ${EndIf}
  data_done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif
