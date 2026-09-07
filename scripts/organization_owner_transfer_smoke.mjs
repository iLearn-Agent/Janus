import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'janus-organization-owner-transfer-'));
let runtime;
let passed = false;

const register = (email, password, displayName) => runtime.authRegister({ email, password, displayName }).user;
const login = (email, password) => runtime.authLogin({ identifier: email, password });
const organizationIdFor = (organizationNumber) => runtime.friendsOverview().organizations
  .find((item) => item.organizationNumber === organizationNumber)?.id || '';
const memberRole = (organizationId, userId) => runtime.db.prepare(`SELECT role FROM contact_organization_members
  WHERE organization_id=? AND user_id=?`).get(organizationId, userId)?.role || '';
const normalizedRoleStatus = (row) => row ? { role: row.role, status: row.status } : null;
const workspaceMembership = (organizationId, userId) => normalizedRoleStatus(runtime.db.prepare(`SELECT role,status
  FROM account_workspace_memberships WHERE workspace_id=? AND user_id=?`).get(`workspace_org_${organizationId}`, userId));
const accountMembership = (organizationId, userId) => normalizedRoleStatus(runtime.db.prepare(`SELECT role,status
  FROM account_memberships WHERE account_id=? AND user_id=?`).get(`account_org_${organizationId}`, userId));

try {
  runtime = await createRuntime({ root, isDev: true });
  const originalOwner = register('transfer-owner@test.local', 'owner12345', 'Original Owner');
  const successor = register('transfer-successor@test.local', 'successor12345', 'Successor');
  const thirdOwner = register('transfer-third@test.local', 'thirdowner12345', 'Third Owner');

  login(originalOwner.email, 'owner12345');
  const created = runtime.organizationCreate({
    name: 'Owner Transfer Smoke',
    organizationNumber: 'OWNER-TRANSFER-2026',
    verificationCode: 'owner-transfer-code',
  });
  const organizationId = created.organization.id;
  login(successor.email, 'successor12345');
  runtime.organizationJoin({ organizationNumber: 'OWNER-TRANSFER-2026', verificationCode: 'owner-transfer-code' });
  login(thirdOwner.email, 'thirdowner12345');
  runtime.organizationJoin({ organizationNumber: 'OWNER-TRANSFER-2026', verificationCode: 'owner-transfer-code' });

  login(originalOwner.email, 'owner12345');
  assert.throws(() => runtime.organizationAction({
    action: 'promote_admin', organizationId, targetUserId: successor.id,
    verificationCode: 'owner-transfer-code', accountPassword: 'wrong-password',
    rememberSecondaryVerification: true,
  }), /账号密码不正确/);
  assert.equal(runtime.auth.hasOrganizationSecondaryVerification(organizationId), false,
    'failed credentials must not establish remembered secondary verification');
  const remembered = runtime.organizationAction({
    action: 'promote_admin', organizationId, targetUserId: successor.id,
    verificationCode: 'owner-transfer-code', accountPassword: 'owner12345',
    rememberSecondaryVerification: true,
  });
  assert.equal(remembered.secondaryVerificationRemembered, true);
  assert.equal(memberRole(organizationId, successor.id), 'admin');
  runtime.organizationAction({
    action: 'revoke_admin', organizationId, targetUserId: successor.id,
    secondaryVerificationExpected: true,
  });
  assert.equal(memberRole(organizationId, successor.id), 'member');
  login(successor.email, 'successor12345');
  login(originalOwner.email, 'owner12345');
  assert.throws(() => runtime.organizationAction({
    action: 'promote_admin', organizationId, targetUserId: successor.id,
    secondaryVerificationExpected: true,
  }), /二次验证已失效/, 'a new login must require secondary verification again');

  assert.throws(() => runtime.organizationAction({
    action: 'transfer_owner',
    organizationId,
    targetUserId: successor.id,
    retainAdmin: 'false',
    verificationCode: 'owner-transfer-code',
    accountPassword: 'owner12345',
  }), /管理员保留选项无效/);
  assert.equal(memberRole(organizationId, originalOwner.id), 'owner');
  assert.equal(memberRole(organizationId, successor.id), 'member');

  const retained = runtime.organizationAction({
    action: 'transfer_owner',
    organizationId,
    targetUserId: successor.id,
    verificationCode: 'owner-transfer-code',
    accountPassword: 'owner12345',
  });
  assert.equal(retained.retainedAdmin, true);
  assert.equal(retained.previousOwnerRole, 'admin');
  assert.equal(memberRole(organizationId, originalOwner.id), 'admin');
  assert.equal(memberRole(organizationId, successor.id), 'owner');
  assert.deepEqual(workspaceMembership(organizationId, originalOwner.id), { role: 'admin', status: 'active' });
  assert.deepEqual(accountMembership(organizationId, originalOwner.id), { role: 'admin', status: 'active' });

  login(successor.email, 'successor12345');
  const demoted = runtime.organizationAction({
    action: 'transfer_owner',
    organizationId,
    targetUserId: thirdOwner.id,
    retainAdmin: false,
    verificationCode: 'owner-transfer-code',
    accountPassword: 'successor12345',
  });
  assert.equal(demoted.retainedAdmin, false);
  assert.equal(demoted.previousOwnerRole, 'member');
  assert.equal(memberRole(organizationId, successor.id), 'member');
  assert.equal(memberRole(organizationId, thirdOwner.id), 'owner');
  assert.deepEqual(workspaceMembership(organizationId, successor.id), { role: 'member', status: 'active' });
  assert.deepEqual(accountMembership(organizationId, successor.id), { role: 'member', status: 'active' });

  login(thirdOwner.email, 'thirdowner12345');
  const exited = await runtime.organizationAction({
    action: 'owner_exit',
    organizationId,
    mode: 'transfer',
    successorUserId: originalOwner.id,
    retainAdmin: true,
    verificationCode: 'owner-transfer-code',
    accountPassword: 'thirdowner12345',
  });
  assert.equal(exited.exited, true);
  assert.equal(exited.retainedAdmin, false);
  assert.equal(organizationIdFor('OWNER-TRANSFER-2026'), '');
  assert.equal(memberRole(organizationId, thirdOwner.id), '');
  assert.equal(memberRole(organizationId, originalOwner.id), 'owner');
  assert.deepEqual(workspaceMembership(organizationId, thirdOwner.id), { role: 'member', status: 'left' });
  assert.deepEqual(accountMembership(organizationId, thirdOwner.id), { role: 'member', status: 'left' });

  login(originalOwner.email, 'owner12345');
  const accountId = `account_org_${organizationId}`;
  runtime.db.exec(`CREATE TRIGGER force_owner_transfer_projection_failure
    BEFORE UPDATE OF owner_user_id ON accounts
    WHEN OLD.id='${accountId}'
    BEGIN SELECT RAISE(ABORT,'forced owner projection failure'); END`);
  try {
    assert.throws(() => runtime.organizationAction({
      action: 'transfer_owner',
      organizationId,
      targetUserId: successor.id,
      retainAdmin: false,
      verificationCode: 'owner-transfer-code',
      accountPassword: 'owner12345',
    }), /forced owner projection failure/);
  } finally {
    runtime.db.exec('DROP TRIGGER IF EXISTS force_owner_transfer_projection_failure');
  }
  assert.equal(runtime.db.prepare('SELECT owner_user_id FROM contact_organizations WHERE id=?').get(organizationId).owner_user_id, originalOwner.id);
  assert.equal(memberRole(organizationId, originalOwner.id), 'owner');
  assert.equal(memberRole(organizationId, successor.id), 'member');
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM contact_organization_members WHERE organization_id=? AND role='owner'").get(organizationId).count, 1);
  assert.equal(runtime.db.prepare('SELECT owner_user_id FROM account_workspaces WHERE id=?').get(`workspace_org_${organizationId}`).owner_user_id, originalOwner.id);
  assert.equal(runtime.db.prepare('SELECT owner_user_id FROM accounts WHERE id=?').get(accountId).owner_user_id, originalOwner.id);
  assert.deepEqual(workspaceMembership(organizationId, originalOwner.id), { role: 'owner', status: 'active' });
  assert.deepEqual(accountMembership(organizationId, originalOwner.id), { role: 'owner', status: 'active' });
  assert.equal(runtime.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(runtime.db.prepare('PRAGMA foreign_key_check').all(), []);

  passed = true;
  console.log('Organization owner transfer smoke passed.');
} finally {
  if (runtime) runtime.close();
  if (passed || !process.env.JANUS_ORGANIZATION_TRANSFER_SMOKE_KEEP) rmSync(root, { recursive: true, force: true });
  else console.log(`Organization owner transfer smoke workspace kept at: ${root}`);
}
