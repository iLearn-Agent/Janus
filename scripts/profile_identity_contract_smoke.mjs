import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { createRuntime } from '../src/main/runtime.js';
import { state } from '../src/renderer/app/state.js';
import { renderSettings } from '../src/renderer/app/views/settingsView.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-profile-identity-'));
let runtime = null;

try {
  runtime = await createRuntime({ root, isDev: true });
  const first = runtime.auth.createVerifiedUser({
    email: 'profile-first@example.com', password: 'profile-password1', displayName: '同名用户', emailVerified: 1,
  });
  const second = runtime.auth.createVerifiedUser({
    email: 'profile-second@example.com', password: 'profile-password1', displayName: '同名用户', emailVerified: 1,
  });
  assert.equal(first.displayName, second.displayName, 'display names may be shared by multiple accounts');

  runtime.auth.setActiveUser(first.id);
  const username32 = 'profile_' + 'a'.repeat(24);
  const updatedFirst = runtime.auth.updateProfile({ displayName: '可见昵称', username: username32 });
  assert.equal(updatedFirst.displayName, '可见昵称');
  assert.equal(updatedFirst.username, username32);
  assert.equal(updatedFirst.username.length, 32, 'local username limit must match the cloud 32-character contract');

  runtime.auth.setActiveUser(second.id);
  assert.throws(() => runtime.auth.updateProfile({ displayName: '可见昵称', username: username32 }), /用户名已被其他账号使用/);
  const updatedSecond = runtime.auth.updateProfile({ displayName: '可见昵称', username: 'PROFILE User 2' });
  assert.equal(updatedSecond.displayName, '可见昵称');
  assert.equal(updatedSecond.username, 'profile_user_2');

  const settingsSource = readFileSync(new URL('../src/renderer/app/views/settingsView.js', import.meta.url), 'utf8');
  assert.match(settingsSource, /显示名称（对外展示）/);
  assert.match(settingsSource, /账号名（唯一 @ 标识）/);
  assert.match(settingsSource, /用于登录、搜索和添加联系人/);
  assert.match(settingsSource, /支持中文/);
  Object.assign(state, {
    currentUser: updatedSecond,
    currentSettingsSection: 'account',
    accountWorkspaces: [],
    startupAccountWorkspace: null,
    activeAccountWorkspace: null,
  });
  const settingsMarkup = renderSettings();
  assert.match(settingsMarkup, /账号名（唯一 @ 标识）/);
  assert.match(settingsMarkup, /pattern="\[a-z0-9_\]\{1,32\}"/);
  assert.match(settingsMarkup, /maxlength="32"/);

  console.log('profile identity contract smoke passed');
} finally {
  await Promise.resolve(runtime?.close?.()).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
