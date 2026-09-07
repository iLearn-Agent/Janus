import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validatePassword as validateCloudPassword } from '../cloud/src/modules/platform/application/cloudServices.mjs';
import { createRuntime } from '../src/main/runtime.js';
import { createIdentityRuntimeApi } from '../src/main/modules/identity/application/createIdentityRuntimeApi.js';
import { hashPassword, validatePassword, verifyPassword } from '../src/main/modules/identity/index.js';
import { registrationValidationMessage } from '../src/renderer/app/features/settings/authController.js';
import { passwordValidationMessage } from '../src/shared/passwordPolicy.js';

const validPassword = 'secure123';
const invalidPasswords = ['short1', '12345678', 'abcdefgh'];

assert.equal(passwordValidationMessage(validPassword), '');
assert.equal(validatePassword(validPassword), validPassword);
assert.equal(validateCloudPassword(validPassword), validPassword);

for (const password of invalidPasswords) {
  assert.notEqual(passwordValidationMessage(password), '');
  assert.throws(() => validatePassword(password));
  assert.throws(() => validateCloudPassword(password), (error) => error?.code === 'invalid_password');
}

assert.equal(registrationValidationMessage({
  email: 'policy@example.com', code: '123456', password: '12345678', passwordConfirm: '12345678',
}), '密码必须同时包含字母和数字。');
assert.equal(registrationValidationMessage({
  email: 'policy@example.com', code: '123456', password: validPassword, passwordConfirm: validPassword,
}), '');

const legacyPassword = '12345678';
const legacyHash = hashPassword(legacyPassword);
assert.equal(verifyPassword(legacyPassword, legacyHash), true);

let remoteCalls = 0;
const remoteBoundary = createIdentityRuntimeApi({
  auth: {
    currentUser: () => null,
    login: () => { throw new Error('local login must not run'); },
    register: () => { throw new Error('local register must not run'); },
    resetPasswordByEmail: () => { throw new Error('local reset must not run'); },
    updatePassword: () => { throw new Error('local update must not run'); },
  },
  socialRelay: {
    enabled: () => true,
    connected: () => true,
    login: async () => { remoteCalls += 1; return {}; },
    register: async () => { remoteCalls += 1; return {}; },
    resetPassword: async () => { remoteCalls += 1; return {}; },
    updatePassword: async () => { remoteCalls += 1; return {}; },
    status: () => ({}),
    state: () => ({}),
  },
  cloudSync: { status: () => ({}), requestAutoSync: () => null },
  currentUser: () => null,
});
assert.throws(() => remoteBoundary.authRegister({ password: '12345678' }), /必须同时包含字母和数字/);
assert.throws(() => remoteBoundary.authLogin({ method: 'email_code', newPassword: '12345678' }), /必须同时包含字母和数字/);
assert.throws(() => remoteBoundary.authResetPasswordByEmail({ newPassword: '12345678' }), /必须同时包含字母和数字/);
assert.throws(() => remoteBoundary.authUpdatePassword({ newPassword: '12345678' }), /必须同时包含字母和数字/);
assert.equal(remoteCalls, 0, 'invalid new passwords must be rejected before any cloud request');

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-password-policy-'));
let runtime;
try {
  runtime = await createRuntime({ root, isDev: true });
  const legacyUser = runtime.auth.createVerifiedUser({
    email: 'legacy-password@example.com',
    displayName: 'Legacy Password User',
    password: validPassword,
    emailVerified: 1,
  });
  runtime.db.prepare('UPDATE auth_users SET password_hash = ? WHERE id = ?').run(legacyHash, legacyUser.id);
  runtime.authLogout();

  const session = runtime.authLogin({ identifier: 'legacy-password@example.com', password: legacyPassword });
  assert.equal(session.user.id, legacyUser.id, 'legacy numeric-only password must remain valid for login');
  assert.throws(
    () => runtime.authUpdatePassword({ currentPassword: legacyPassword, newPassword: '87654321' }),
    /必须同时包含字母和数字/,
  );
  assert.equal(runtime.authUpdatePassword({ currentPassword: legacyPassword, newPassword: 'replacement123' }).ok, true);
} finally {
  runtime?.close?.();
  rmSync(root, { recursive: true, force: true });
}

console.log('password policy smoke passed');
