import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuthService } from '../src/main/auth.js';
import { openDatabase } from '../src/main/db.js';
import { createIdentityRuntimeApi } from '../src/main/modules/identity/application/createIdentityRuntimeApi.js';
import { SocialRelayService } from '../src/main/socialRelay.js';
import { normalizeProfileAvatarUrl, profileAvatarUrlValidation } from '../src/shared/profileAvatar.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-profile-update-outbox-'));
const avatarUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=';
let db;

try {
  db = openDatabase(root, { skipMigrationBackup: true });
  let auth = new AuthService(db);
  db.prepare(`UPDATE auth_users SET remote_id='remote_profile_user',auth_provider='cloud',email='profile@example.com',
    display_name='Profile User',username='profile_user' WHERE id='local_admin'`).run();
  let relay = new SocialRelayService({ db, auth, client: profileClient() });
  db.prepare(`UPDATE cloud_auth_state SET server_url='https://profile.example.invalid',enabled=1,
    remote_user_id='remote_profile_user',access_token='',refresh_token='' WHERE id='default'`).run();

  const identity = createIdentityRuntimeApi({
    auth,
    socialRelay: relay,
    cloudSync: { status: () => ({}), requestAutoSync: () => null, saveConfig: () => ({}) },
    currentUser: () => auth.currentUser(),
  });
  const saved = await identity.authUpdateProfile({ displayName: 'Offline Profile', username: 'offline_profile', avatarUrl });
  assert.equal(saved.profileSyncPending, true);
  assert.equal(auth.currentUser().avatarUrl, avatarUrl);
  assert.equal(auth.profileUpdateOutbox('local_admin').status, 'pending');
  assert.throws(() => auth.updateProfile({ avatarUrl: 'file:///private/avatar.png' }), /不能使用仅本机可访问/);
  assert.equal(normalizeProfileAvatarUrl('file:///legacy/avatar.png'), 'file:///legacy/avatar.png', 'legacy local avatars remain displayable');
  assert.equal(normalizeProfileAvatarUrl('http://legacy.example/avatar.png'), 'http://legacy.example/avatar.png', 'legacy HTTP avatars remain displayable');
  assert.equal(profileAvatarUrlValidation('file:///new/avatar.png').valid, false);
  assert.equal(profileAvatarUrlValidation('http://new.example/avatar.png').valid, false);
  db.prepare("UPDATE auth_users SET avatar_url='file:///legacy/avatar.png' WHERE id='local_admin'").run();
  await identity.authUpdateProfile({ displayName: 'Legacy Avatar Profile', username: 'legacy_avatar', avatarUrl: 'file:///legacy/avatar.png' });
  assert.equal(auth.currentUser().avatarUrl, 'file:///legacy/avatar.png');
  assert.equal(Object.hasOwn(auth.profileUpdateOutbox('local_admin').payload, 'avatarUrl'), false,
    'unchanged legacy avatar must not be retransmitted as a new cloud value');
  await identity.authUpdateProfile({ displayName: 'Offline Profile', username: 'offline_profile', avatarUrl });

  db.close();
  db = openDatabase(root, { skipMigrationBackup: true });
  auth = new AuthService(db);
  assert.equal(auth.profileUpdateOutbox('local_admin').status, 'pending', 'pending profile intent must survive restart');
  db.prepare(`UPDATE cloud_auth_state SET access_token='profile-access-token',refresh_token='profile-refresh-token',
    updated_at=datetime('now') WHERE id='default'`).run();
  const requests = [];
  relay = new SocialRelayService({ db, auth, client: profileClient(requests) });
  const sync = await relay.syncProfileUpdateOutbox();
  assert.deepEqual(sync, { processed: 1, completed: 1, failed: 0 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].avatarUrl, avatarUrl);
  assert.equal(auth.profileUpdateOutbox('local_admin').status, 'completed');
  assert.deepEqual(auth.profileUpdateOutbox('local_admin').payload, {}, 'completed payload must be scrubbed');
  await relay.updateProfile({ displayName: 'Preserved Username', username: '   ' });
  assert.equal(requests.length, 2);
  assert.equal(Object.hasOwn(requests[1], 'username'), false,
    'blank legacy profile usernames must be omitted so the cloud preserves its established login name');
  assert.equal(auth.currentUser().username, 'offline_profile');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  db.close();
  db = openDatabase(root, { skipMigrationBackup: true });
  assert.equal(db.prepare("SELECT count(*) AS count FROM schema_migrations WHERE id='profile_update_outbox_v1'").get().count, 1);
  assert.equal(db.prepare("SELECT status FROM profile_update_outbox WHERE user_id='local_admin'").get().status, 'completed');
  const settingsControllerSource = fs.readFileSync(new URL('../src/renderer/app/features/settings/authController.js', import.meta.url), 'utf8');
  assert.match(settingsControllerSource, /连接通信服务器后会自动同步/);
  assert.match(settingsControllerSource, /await persistProfileChanges\(\{ avatarUrl, successMessage: '头像已保存。' \}\)/,
    'selecting a cropped avatar must persist it immediately instead of leaving an in-memory draft');
  assert.match(settingsControllerSource, /async function removeProfileAvatar[\s\S]*persistProfileChanges\(\{ avatarUrl: '', successMessage: '头像已移除。' \}\)/,
    'removing an avatar must persist immediately');
  assert.match(settingsControllerSource, /function openAvatarViewer[\s\S]*avatar-viewer-download[\s\S]*downloadAvatarImage/,
    'avatar viewer must expose a download action');
  process.stdout.write('Profile update outbox and avatar portability smoke passed.\n');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}

function profileClient(requests = []) {
  return {
    async updateProfile(_state, payload = {}) {
      requests.push(payload);
      return {
        user: {
          id: 'remote_profile_user', email: 'profile@example.com', displayName: payload.displayName,
          username: payload.username, avatarUrl: payload.avatarUrl, emailVerified: true, role: 'admin',
          updatedAt: new Date().toISOString(),
        },
      };
    },
  };
}
