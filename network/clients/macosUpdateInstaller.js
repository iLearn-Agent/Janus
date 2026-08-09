import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { checksumsEqual, sha512File, verifyUpdateMetadata } from '../../src/shared/updateSignature.js';

const MACOS_APPLICATION_TARGETS = new Set([
  '/Applications/Janus.app',
  '/Applications/Janus Test.app',
]);

export async function verifyDesktopUpdatePackage({ file, updateInfo, publicKeyPem, extension = '.zip' } = {}) {
  if (!file || !fs.existsSync(file)) throw new Error('Downloaded desktop update package is missing.');
  const metadata = updateInfo?.janusUpdateSignature;
  const normalizedExtension = String(extension || '').toLowerCase();
  const fileEntry = (updateInfo?.files || []).find((entry) => String(entry?.url || '').split(/[?#]/, 1)[0].toLowerCase().endsWith(normalizedExtension));
  if (!fileEntry?.sha512) throw new Error('Desktop update manifest does not contain the package SHA-512 checksum.');
  const stat = await fsp.stat(file);
  const actualSha512 = await sha512File(file);
  const fileName = path.basename(String(fileEntry.url || '').split(/[?#]/, 1)[0]);
  if (!checksumsEqual(actualSha512, fileEntry.sha512)) throw new Error('Downloaded desktop update package failed SHA-512 verification.');
  if (
    String(metadata?.version || '') !== String(updateInfo?.version || '')
    || String(metadata?.file || '') !== fileName
    || !checksumsEqual(metadata?.sha512, actualSha512)
    || Number(metadata?.size) !== stat.size
  ) {
    throw new Error('Signed desktop update metadata does not match the downloaded package.');
  }
  verifyUpdateMetadata(metadata, publicKeyPem);
  return { metadata, actualSha512, size: stat.size };
}

export function verifyMacUpdatePackage(options = {}) {
  return verifyDesktopUpdatePackage({ ...options, extension: '.zip' });
}

export function macAppBundleFromExecutable(executablePath = '') {
  let current = path.resolve(executablePath || '/');
  while (current !== path.dirname(current)) {
    if (current.toLowerCase().endsWith('.app')) return current;
    current = path.dirname(current);
  }
  return '';
}

export async function launchMacCustomInstaller({ zipFile, currentAppBundle, appPid = process.pid } = {}) {
  if (process.platform !== 'darwin') throw new Error('The custom macOS updater can only run on macOS.');
  const applicationTarget = path.resolve(currentAppBundle || '');
  if (!MACOS_APPLICATION_TARGETS.has(applicationTarget)) {
    throw new Error('Custom updates require Janus or Janus Test to be installed in /Applications.');
  }
  if (!zipFile || !fs.existsSync(zipFile)) throw new Error('Downloaded macOS update ZIP is missing.');

  const scriptDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'janus-updater-'));
  const runnerPath = path.join(scriptDir, 'run-update.sh');
  const appleScriptPath = path.join(scriptDir, 'authorize.applescript');
  const privilegedPath = path.join(scriptDir, 'privileged-install.sh');
  const logPath = path.join(os.tmpdir(), 'janus-update.log');
  await Promise.all([
    fsp.writeFile(runnerPath, runnerScript(), { mode: 0o700 }),
    fsp.writeFile(appleScriptPath, authorizationScript(), { mode: 0o600 }),
    fsp.writeFile(privilegedPath, privilegedInstallScript(), { mode: 0o700 }),
  ]);

  const child = spawn('/bin/bash', [
    runnerPath,
    zipFile,
    applicationTarget,
    String(appPid),
    logPath,
    scriptDir,
  ], {
    detached: true,
    stdio: 'ignore',
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return { pid: child.pid, target: applicationTarget, logPath };
}

function runnerScript() {
  return `#!/bin/bash
set -euo pipefail
ZIP_FILE="$1"
TARGET_APP="$2"
APP_PID="$3"
LOG_FILE="$4"
SCRIPT_DIR="$5"
exec >>"$LOG_FILE" 2>&1

for ((attempt = 0; attempt < 180; attempt++)); do
  if ! /bin/kill -0 "$APP_PID" 2>/dev/null; then
    break
  fi
  /bin/sleep 1
done
if /bin/kill -0 "$APP_PID" 2>/dev/null; then
  echo "Janus did not exit before the updater timeout."
  exit 1
fi

WORK_DIR="$(/usr/bin/mktemp -d /tmp/janus-update-payload.XXXXXX)"
cleanup() {
  status=$?
  trap - EXIT
  /bin/rm -rf "$WORK_DIR" "$SCRIPT_DIR"
  if [[ $status -ne 0 && -d "$TARGET_APP" ]]; then
    /usr/bin/open "$TARGET_APP" || true
  fi
  exit "$status"
}
trap cleanup EXIT
/usr/bin/ditto -x -k "$ZIP_FILE" "$WORK_DIR"
APP_BASENAME="$(/usr/bin/basename "$TARGET_APP")"
NEW_APP="$WORK_DIR/$APP_BASENAME"
test -d "$NEW_APP/Contents/MacOS"
/usr/bin/osascript "$SCRIPT_DIR/authorize.applescript" \
  "$SCRIPT_DIR/privileged-install.sh" "$NEW_APP" "$TARGET_APP"
/usr/bin/open "$TARGET_APP"
`;
}

function authorizationScript() {
  return `on run argv
  set installerPath to item 1 of argv
  set sourceApp to item 2 of argv
  set targetApp to item 3 of argv
  do shell script "/bin/bash " & quoted form of installerPath & " " & quoted form of sourceApp & " " & quoted form of targetApp with administrator privileges
end run
`;
}

function privilegedInstallScript() {
  return `#!/bin/bash
set -euo pipefail
SOURCE_APP="$1"
TARGET_APP="$2"
if [[ "$TARGET_APP" != "/Applications/Janus.app" && "$TARGET_APP" != "/Applications/Janus Test.app" ]]; then
  echo "Refusing unexpected application target: $TARGET_APP" >&2
  exit 2
fi
test -d "$SOURCE_APP/Contents/MacOS"
APP_BASENAME="$(/usr/bin/basename "$TARGET_APP")"
STAGED_APP="/Applications/.$APP_BASENAME.update.$$"
BACKUP_APP="/Applications/.$APP_BASENAME.backup.$$"
rollback() {
  /bin/rm -rf "$STAGED_APP"
  if [[ -e "$BACKUP_APP" && ! -e "$TARGET_APP" ]]; then
    /bin/mv "$BACKUP_APP" "$TARGET_APP"
  fi
}
trap rollback EXIT
/bin/rm -rf "$STAGED_APP" "$BACKUP_APP"
/usr/bin/ditto "$SOURCE_APP" "$STAGED_APP"
/usr/bin/xattr -cr "$STAGED_APP"
/usr/bin/codesign --force --deep --sign - "$STAGED_APP"
if [[ -e "$TARGET_APP" ]]; then
  /bin/mv "$TARGET_APP" "$BACKUP_APP"
fi
/bin/mv "$STAGED_APP" "$TARGET_APP"
/bin/rm -rf "$BACKUP_APP"
trap - EXIT
`;
}
