import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const installer = await readFile(new URL('../deploy/installer.windows.nsh', import.meta.url), 'utf8');
const builder = await readFile(new URL('../deploy/electron-builder.windows.cjs', import.meta.url), 'utf8');

assert.match(builder, /oneClick:\s*false/);
assert.match(builder, /runAfterFinish:\s*true/);
assert.match(installer, /\$\{IfNot\} \$\{Silent\}[\s\S]*\$\{If\} \$\{isUpdated\}[\s\S]*\$hasPerMachineInstallation == "1"[\s\S]*\$hasPerUserInstallation == "1"[\s\S]*janusStartUpgradeProgress/);
assert.match(installer, /JANUS_PBM_SETMARQUEE\} 1 36/);
assert.match(installer, /JANUS_SWP_FRAMECHANGED_FLAGS/);
assert.match(installer, /正在移除旧版本，请稍候/);
assert.match(installer, /!macro janusHandleUninstallResult[\s\S]*janusKeepUpgradeProgress "\$\{NEXT_STATUS\}"/);
assert.match(installer, /!macro customUnInstallCheck[\s\S]*正在安装新版本，请勿关闭安装程序/);
assert.match(installer, /!macro customUnInstallCheckCurrentUser[\s\S]*正在安装新版本，请勿关闭安装程序/);
assert.match(installer, /!macro customInstall[\s\S]*janusCompleteUpgradeProgress/);
assert.match(installer, /正在完成升级/);
assert.match(installer, /JANUS_PBM_SETMARQUEE\} 0 0/);
assert.match(installer, /JANUS_PBM_SETPOS\} 100 0/);
assert.match(installer, /\$\{If\} \$\{isUpdated\}[\s\S]*\$\{AndIf\} \$\{isForceRun\}[\s\S]*\$\{AndIfNot\} \$\{Silent\}/);
assert.match(installer, /StdUtils\.ExecShellAsUser[\s\S]*\$launchLink[\s\S]*--updated/);
assert.match(installer, /!insertmacro quitSuccess/);
assert.match(installer, /janusKillProcessesFromInstallDirectory[\s\S]*Get-Process[\s\S]*StartsWith\(\$\$root,\[StringComparison\]::OrdinalIgnoreCase\)[\s\S]*taskkill\.exe'[\s\S]*\/F \/T \/PID/);
assert.match(installer, /janusProcessWait:[\s\S]*janusFindProcessFromInstallDirectory \$4[\s\S]*\$3 == 5[\s\S]*retrying forced cleanup[\s\S]*\$3 < 14[\s\S]*Sleep 750/);
assert.match(installer, /Uninstall was not successful\. Not able to launch uninstaller/);
assert.match(installer, /SetErrorLevel 2[\s\S]*Quit/);

console.log('windows installer upgrade progress smoke passed');
