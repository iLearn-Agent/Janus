import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCloudServer } from '../src/cloud/server.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-cloud-account-workspace-'));
const cloud = createCloudServer({ home, token: 'workspace-admin-token', syncToken: 'workspace-sync-token' });
let baseUrl = '';

try {
  seedUser('workspace_alice', 'Workspace Alice', 'workspace-alice-token');
  seedUser('workspace_bob', 'Workspace Bob', 'workspace-bob-token');
  seedUser('workspace_outsider', 'Workspace Outsider', 'workspace-outsider-token');
  cloud.db.prepare(`INSERT INTO friendships(id,user_a_id,user_b_id,status)
    VALUES('workspace_friendship','workspace_alice','workspace_bob','accepted')`).run();
  cloud.db.prepare(`INSERT INTO contact_organizations(
    id,organization_number,name,verification_code_salt,verification_code_hash,owner_user_id
  ) VALUES('workspace_org','WORKSPACE-ORG','Workspace Organization','salt','hash','workspace_alice')`).run();
  cloud.db.prepare(`INSERT INTO contact_organization_members(organization_id,user_id,role)
    VALUES('workspace_org','workspace_alice','owner'),('workspace_org','workspace_bob','member')`).run();

  const address = await cloud.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://${address.host}:${address.port}`;
  const organizationWorkspaceId = 'workspace_org_workspace_org';

  const personalDelegation = await api('workspace-alice-token', 'POST', '/api/delegations', {
    recipientId: 'workspace_bob',
    title: 'Personal Delegation',
    instruction: 'personal only',
  }, 201);
  const organizationDelegation = await api('workspace-alice-token', 'POST', '/api/delegations', {
    workspaceId: organizationWorkspaceId,
    recipientId: 'workspace_bob',
    title: 'Organization Delegation',
    instruction: 'organization only',
  }, 201);
  assert.equal(personalDelegation.delegation.workspaceId, 'workspace_personal');
  assert.equal(organizationDelegation.delegation.workspaceId, organizationWorkspaceId);
  assert.deepEqual((await api('workspace-alice-token', 'GET', '/api/delegations')).items.map((item) => item.id), [personalDelegation.delegation.id]);
  assert.deepEqual((await api('workspace-alice-token', 'GET', `/api/delegations?workspaceId=${encodeURIComponent(organizationWorkspaceId)}`)).items.map((item) => item.id), [organizationDelegation.delegation.id]);

  const sharedRequestId = 'workspace-shared-request-id';
  const personalGroup = await api('workspace-alice-token', 'POST', '/api/collaboration/groups', {
    clientRequestId: sharedRequestId,
    title: 'Personal Group',
    assignments: [{ recipientId: 'workspace_bob', instruction: 'personal group task' }],
  }, 201);
  const organizationGroup = await api('workspace-alice-token', 'POST', '/api/collaboration/groups', {
    workspaceId: organizationWorkspaceId,
    clientRequestId: sharedRequestId,
    title: 'Organization Group',
    assignments: [{ recipientId: 'workspace_bob', instruction: 'organization group task' }],
  }, 201);
  assert.notEqual(personalGroup.group.id, organizationGroup.group.id);
  assert.equal(personalGroup.group.workspaceId, 'workspace_personal');
  assert.equal(organizationGroup.group.workspaceId, organizationWorkspaceId);
  assert.equal((await api('workspace-alice-token', 'GET', '/api/collaboration')).groups.some((item) => item.id === organizationGroup.group.id), false);
  assert.equal((await api('workspace-alice-token', 'GET', `/api/collaboration?workspaceId=${encodeURIComponent(organizationWorkspaceId)}`)).groups.some((item) => item.id === organizationGroup.group.id), true);

  await api('workspace-outsider-token', 'GET', `/api/collaboration?workspaceId=${encodeURIComponent(organizationWorkspaceId)}`, undefined, 403);
  cloud.db.prepare("DELETE FROM contact_organization_members WHERE organization_id='workspace_org' AND user_id='workspace_bob'").run();
  await api('workspace-bob-token', 'GET', `/api/delegations?workspaceId=${encodeURIComponent(organizationWorkspaceId)}`, undefined, 403);
  await api('workspace-bob-token', 'GET', `/api/collaboration/groups/${organizationGroup.group.id}?workspaceId=${encodeURIComponent(organizationWorkspaceId)}`, undefined, 403);

  assert.equal(cloud.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  console.log(JSON.stringify({
    ok: true,
    personalDelegationId: personalDelegation.delegation.id,
    organizationDelegationId: organizationDelegation.delegation.id,
    personalGroupId: personalGroup.group.id,
    organizationGroupId: organizationGroup.group.id,
  }, null, 2));
} finally {
  await cloud.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}

function seedUser(id, displayName, token) {
  cloud.db.prepare(`INSERT INTO users(id,email,display_name,username,password_hash)
    VALUES(?,?,?,?,?)`).run(id, `${id}@example.test`, displayName, id, 'workspace-password-hash');
  cloud.db.prepare('INSERT INTO auth_access_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)').run(
    crypto.createHash('sha256').update(token).digest('hex'),
    id,
    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  );
}

async function api(token, method, pathname, body, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, `${method} ${pathname}: ${JSON.stringify(payload)}`);
  return payload;
}
