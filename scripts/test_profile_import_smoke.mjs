#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { importStableProfileForTest } from '../src/main/testProfileMigration.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-test-profile-import-'));
const stable = path.join(root, 'stable');
const target = path.join(root, 'test');
fs.mkdirSync(path.join(stable, 'data'), { recursive: true });
fs.mkdirSync(path.join(target, 'data'), { recursive: true });

const stableDb = new DatabaseSync(path.join(stable, 'data', 'janus.db'));
stableDb.exec(`
  CREATE TABLE cloud_auth_state (id TEXT PRIMARY KEY, server_url TEXT, access_token TEXT, refresh_token TEXT, remote_user_id TEXT, device_id TEXT, enabled INTEGER, last_social_cursor TEXT, last_social_message_cursor TEXT, last_delegation_cursor TEXT, last_presence_at TEXT, last_error TEXT, updated_at TEXT);
  CREATE TABLE cloud_sync_state (id TEXT PRIMARY KEY, user_id TEXT, device_id TEXT, server_url TEXT, token TEXT, evolution_grant TEXT, device_grant TEXT, sync_capabilities_json TEXT, last_sync_cursor TEXT, last_v6_cursor TEXT, last_identity_cursor TEXT, last_personal_evolution_cursor TEXT, last_success_at TEXT, last_error TEXT, updated_at TEXT);
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO cloud_auth_state VALUES ('default','http://cloud','access','refresh','remote-user','stable-device',1,'','','','','','');
  INSERT INTO cloud_sync_state VALUES ('default','remote-user','stable-device','http://cloud','token','old-evolution','old-device','{"old":true}','cursor','v6','identity','evolution','success','error','');
  INSERT INTO app_settings VALUES ('social:realtime_cursor:remote-user:stable-device','12');
`);
stableDb.close();
fs.writeFileSync(path.join(stable, 'PROJECT_MEMORY.md'), 'stable history');
fs.writeFileSync(path.join(target, 'PROJECT_MEMORY.md'), 'old test history');

const first = importStableProfileForTest({ targetRoot: target, stableRoot: stable, appVersion: 'test-1', logger: { info() {} } });
assert.equal(first.status, 'imported');
const imported = new DatabaseSync(path.join(target, 'data', 'janus.db'), { readOnly: true });
const auth = imported.prepare("SELECT * FROM cloud_auth_state WHERE id='default'").get();
const sync = imported.prepare("SELECT * FROM cloud_sync_state WHERE id='default'").get();
assert.equal(auth.remote_user_id, 'remote-user');
assert.notEqual(auth.device_id, 'stable-device');
assert.equal(sync.user_id, 'remote-user');
assert.equal(sync.device_grant, '');
assert.equal(sync.evolution_grant, '');
assert.equal(imported.prepare('SELECT COUNT(*) AS count FROM app_settings').get().count, 0);
imported.close();
assert.equal(fs.readFileSync(path.join(target, 'PROJECT_MEMORY.md'), 'utf8'), 'stable history');
assert.equal(importStableProfileForTest({ targetRoot: target, stableRoot: stable, appVersion: 'test-1' }).status, 'already_seeded');
const testDb = new DatabaseSync(path.join(target, 'data', 'janus.db'));
testDb.prepare("INSERT INTO app_settings(key,value) VALUES('test:upgrade-preserved','yes')").run();
testDb.close();
const upgraded = importStableProfileForTest({ targetRoot: target, stableRoot: stable, appVersion: 'test-2' });
assert.equal(upgraded.status, 'already_seeded');
assert.equal(upgraded.appVersion, 'test-1');
assert.equal(upgraded.requestedVersion, 'test-2');
const afterUpgrade = new DatabaseSync(path.join(target, 'data', 'janus.db'), { readOnly: true });
assert.equal(afterUpgrade.prepare("SELECT value FROM app_settings WHERE key='test:upgrade-preserved'").get().value, 'yes');
afterUpgrade.close();
assert.equal(fs.readFileSync(path.join(target, 'PROJECT_MEMORY.md'), 'utf8'), 'stable history');
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write('Test profile import smoke passed.\n');
