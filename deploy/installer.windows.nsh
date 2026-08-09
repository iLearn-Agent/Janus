!ifndef BUILD_UNINSTALLER
  Var /GLOBAL janusUpgradeProgressActive

  !define JANUS_INSTALL_PROGRESS_CONTROL 1004
  !define JANUS_INSTALL_STATUS_CONTROL 1006
  !define JANUS_PBS_MARQUEE 0x00000008
  !define JANUS_GWL_STYLE -16
  !define JANUS_PBM_SETPOS 0x0402
  !define JANUS_PBM_SETRANGE32 0x0406
  !define JANUS_PBM_SETMARQUEE 0x040A
  !define JANUS_SWP_FRAMECHANGED_FLAGS 0x0027

  !macro janusSetUpgradeStatus TEXT
    ${If} $janusUpgradeProgressActive == "1"
      Push $R7
      GetDlgItem $R7 $HWNDPARENT ${JANUS_INSTALL_STATUS_CONTROL}
      ${If} $R7 != 0
        SendMessage $R7 ${WM_SETTEXT} 0 "STR:${TEXT}"
      ${EndIf}
      Pop $R7
    ${EndIf}
  !macroend

  !macro janusKeepUpgradeProgress STATUS_TEXT
    Push $R7
    Push $R8
    ${If} $janusUpgradeProgressActive == "1"
      GetDlgItem $R7 $HWNDPARENT ${JANUS_INSTALL_PROGRESS_CONTROL}
      ${If} $R7 != 0
        System::Call 'user32::GetWindowLong(p r7, i ${JANUS_GWL_STYLE}) i .r8'
        IntOp $R8 $R8 | ${JANUS_PBS_MARQUEE}
        System::Call 'user32::SetWindowLong(p r7, i ${JANUS_GWL_STYLE}, i r8)'
        System::Call 'user32::SetWindowPos(p r7, p 0, i 0, i 0, i 0, i 0, i ${JANUS_SWP_FRAMECHANGED_FLAGS})'
        SendMessage $R7 ${JANUS_PBM_SETMARQUEE} 1 36
      ${EndIf}
    ${EndIf}
    Pop $R8
    Pop $R7
    !insertmacro janusSetUpgradeStatus "${STATUS_TEXT}"
  !macroend

  !macro janusStartUpgradeProgress
    StrCpy $janusUpgradeProgressActive "1"
    !insertmacro janusKeepUpgradeProgress "正在移除旧版本，请稍候…"
  !macroend

  !macro janusCompleteUpgradeProgress
    ${If} $janusUpgradeProgressActive == "1"
      !insertmacro janusSetUpgradeStatus "正在完成升级…"
      Push $R7
      Push $R8
      GetDlgItem $R7 $HWNDPARENT ${JANUS_INSTALL_PROGRESS_CONTROL}
      ${If} $R7 != 0
        SendMessage $R7 ${JANUS_PBM_SETMARQUEE} 0 0
        System::Call 'user32::GetWindowLong(p r7, i ${JANUS_GWL_STYLE}) i .r8'
        IntOp $R8 $R8 & 0xFFFFFFF7
        System::Call 'user32::SetWindowLong(p r7, i ${JANUS_GWL_STYLE}, i r8)'
        System::Call 'user32::SetWindowPos(p r7, p 0, i 0, i 0, i 0, i 0, i ${JANUS_SWP_FRAMECHANGED_FLAGS})'
        SendMessage $R7 ${JANUS_PBM_SETRANGE32} 0 100
        SendMessage $R7 ${JANUS_PBM_SETPOS} 100 0
      ${EndIf}
      Pop $R8
      Pop $R7
      StrCpy $janusUpgradeProgressActive "0"
    ${EndIf}
  !macroend

  !macro janusHandleUninstallResult NEXT_STATUS
    ${If} ${Errors}
      DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
    ${ElseIf} $R0 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
      DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
      SetErrorLevel 2
      Quit
    ${Else}
      !insertmacro janusKeepUpgradeProgress "${NEXT_STATUS}"
    ${EndIf}
  !macroend

  !macro janusKillProcessesFromInstallDirectory
    Push $R5
    Push $R6
    DetailPrint "Closing residual ${PRODUCT_NAME} helper processes from $INSTDIR."
    nsExec::ExecToStack /TIMEOUT=30000 `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$root=[IO.Path]::GetFullPath($$args[0]); if(-not $$root.EndsWith([IO.Path]::DirectorySeparatorChar)){ $$root += [IO.Path]::DirectorySeparatorChar }; Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $$_.Path -and [IO.Path]::GetFullPath($$_.Path).StartsWith($$root,[StringComparison]::OrdinalIgnoreCase) } catch { $$false } } | ForEach-Object { & '$SYSDIR\taskkill.exe' /F /T /PID $$_.Id | Out-Null }; exit 0" "$INSTDIR"`
    Pop $R5
    Pop $R6
    ${If} $R5 != 0
      DetailPrint "Residual process cleanup returned code $R5: $R6"
    ${EndIf}
    Pop $R6
    Pop $R5
  !macroend

  !macro janusFindProcessFromInstallDirectory RESULT
    Push $R5
    nsExec::ExecToStack /TIMEOUT=10000 `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$root=[IO.Path]::GetFullPath($$args[0]); if(-not $$root.EndsWith([IO.Path]::DirectorySeparatorChar)){ $$root += [IO.Path]::DirectorySeparatorChar }; $$found=Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $$_.Path -and [IO.Path]::GetFullPath($$_.Path).StartsWith($$root,[StringComparison]::OrdinalIgnoreCase) } catch { $$false } } | Select-Object -First 1; if($$found){ exit 0 }; exit 1" "$INSTDIR"`
    Pop ${RESULT}
    Pop $R5
    Pop $R5
  !macroend
!endif

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    ${IfNot} ${Silent}
      ${If} ${isUpdated}
      ${OrIf} $hasPerMachineInstallation == "1"
      ${OrIf} $hasPerUserInstallation == "1"
        !insertmacro janusStartUpgradeProgress
      ${EndIf}
    ${EndIf}
    DetailPrint "Preparing ${PRODUCT_NAME} for automatic upgrade."
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $0
    ${If} $0 == 0
      DetailPrint "Closing the installed ${PRODUCT_NAME} process tree before uninstalling the old version."
      nsExec::ExecToStack /TIMEOUT=20000 `"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
      Pop $1
      Pop $2
      Sleep 1500
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $0
      ${If} $0 == 0
        DetailPrint "The process tree command did not close ${PRODUCT_NAME}; using the installer process fallback."
        ${nsProcess::KillProcess} "${APP_EXECUTABLE_FILENAME}" $0
        Sleep 1000
      ${EndIf}
    ${EndIf}
    !insertmacro janusKillProcessesFromInstallDirectory
    StrCpy $3 0
    janusProcessWait:
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $0
      !insertmacro janusFindProcessFromInstallDirectory $4
      ${If} $0 != 0
      ${AndIf} $4 != 0
        Goto janusProcessClosed
      ${EndIf}
      IntOp $3 $3 + 1
      ${If} $3 == 5
        DetailPrint "Residual processes are still exiting; retrying forced cleanup."
        nsExec::ExecToStack /TIMEOUT=20000 `"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
        Pop $1
        Pop $2
        !insertmacro janusKillProcessesFromInstallDirectory
      ${EndIf}
      ${If} $3 < 14
        Sleep 750
        Goto janusProcessWait
      ${EndIf}
      MessageBox MB_OK|MB_ICONSTOP "Unable to close ${PRODUCT_NAME} and its helper processes. Please close them and run the installer again." /SD IDOK
      SetErrorLevel 2
      Quit
    janusProcessClosed:
    ${nsProcess::Unload}
  !endif
!macroend

!macro customUnInstallCheck
  !ifndef BUILD_UNINSTALLER
    ${If} $installMode == "all"
      !insertmacro janusHandleUninstallResult "正在检查并移除其他旧版本…"
    ${Else}
      !insertmacro janusHandleUninstallResult "正在安装新版本，请勿关闭安装程序…"
    ${EndIf}
  !endif
!macroend

!macro customUnInstallCheckCurrentUser
  !ifndef BUILD_UNINSTALLER
    !insertmacro janusHandleUninstallResult "正在安装新版本，请勿关闭安装程序…"
  !endif
!macroend

!macro customInstall
  !ifndef BUILD_UNINSTALLER
    !insertmacro janusCompleteUpgradeProgress
    ${If} ${isUpdated}
    ${AndIf} ${isForceRun}
    ${AndIfNot} ${Silent}
      DetailPrint "Upgrade completed. Restarting ${PRODUCT_NAME}."
      HideWindow
      ${StdUtils.ExecShellAsUser} $R0 "$launchLink" "open" "--updated"
      !insertmacro quitSuccess
    ${EndIf}
  !endif
!macroend
