import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

const root = path.resolve(argument('--root') || process.env.JANUS_HOME || '');
const backupPath = path.resolve(argument('--backup') || '');
if (!root || !backupPath || !fs.existsSync(backupPath)) {
  throw new Error('Usage: node scripts/restore_database_backup.mjs --root <janus-root> --backup <backup.db>');
}

const verify = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return String(db.prepare('PRAGMA integrity_check').get()?.integrity_check || 'unknown'); }
  finally { db.close(); }
};

if (verify(backupPath) !== 'ok') throw new Error('Backup database failed integrity_check.');
const target = path.join(root, 'data', 'janus.db');
const targetTaskMemoryKey = path.join(root, 'data', 'task-memory-device-key.json');
let metadata = {};
try { metadata = JSON.parse(fs.readFileSync(`${backupPath}.json`, 'utf8')); } catch { metadata = {}; }
const recordedTaskMemoryKeyBackup = String(metadata.taskMemoryKeyBackupPath || '');
const siblingTaskMemoryKeyBackup = `${backupPath}.task-memory-key.json`;
const taskMemoryKeyBackup = recordedTaskMemoryKeyBackup && fs.existsSync(recordedTaskMemoryKeyBackup)
  ? recordedTaskMemoryKeyBackup
  : siblingTaskMemoryKeyBackup;
fs.mkdirSync(path.dirname(target), { recursive: true });
const emergency = `${target}.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const taskMemoryKeyEmergency = `${targetTaskMemoryKey}.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
if (fs.existsSync(target)) fs.copyFileSync(target, emergency);
if (fs.existsSync(taskMemoryKeyBackup) && fs.existsSync(targetTaskMemoryKey)) fs.copyFileSync(targetTaskMemoryKey, taskMemoryKeyEmergency);
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
fs.copyFileSync(backupPath, target);
if (fs.existsSync(taskMemoryKeyBackup)) {
  fs.copyFileSync(taskMemoryKeyBackup, targetTaskMemoryKey);
  fs.chmodSync(targetTaskMemoryKey, 0o600);
}
if (verify(target) !== 'ok') {
  if (fs.existsSync(emergency)) fs.copyFileSync(emergency, target);
  if (fs.existsSync(taskMemoryKeyEmergency)) fs.copyFileSync(taskMemoryKeyEmergency, targetTaskMemoryKey);
  throw new Error('Restored database failed integrity_check; the previous database was restored.');
}
process.stdout.write(`${JSON.stringify({ status: 'restored', target, backupPath, emergency,
  taskMemoryKeyRestored: fs.existsSync(taskMemoryKeyBackup), taskMemoryKeyEmergency }, null, 2)}\n`);
