import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { SocialRelayService } from '../src/main/socialRelay.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-account-workspace-bootstrap-'));
let runtime = null;

try {
  runtime = await createRuntime({ root, isDev: true });
  const user = runtime.auth.currentUser();
  const organizationId = 'org_workspace_bootstrap_smoke';
  const organizationWorkspaceId = `workspace_org_${organizationId}`;

  runtime.db.prepare(`INSERT INTO contact_organizations(
      id,organization_number,name,verification_code_salt,verification_code_hash,owner_user_id
    ) VALUES(?,?,?,?,?,?)`).run(
    organizationId,
    'WORKSPACE-BOOTSTRAP-SMOKE',
    'Workspace Bootstrap Smoke',
    'salt',
    'hash',
    user.id,
  );
  runtime.db.prepare(`INSERT INTO contact_organization_members(organization_id,user_id,role)
    VALUES(?,?,'owner')`).run(organizationId, user.id);
  runtime.db.prepare(`INSERT INTO auth_users(id,email,display_name,username,role,email_verified)
    VALUES('workspace_bootstrap_peer','peer@workspace-bootstrap.test','Workspace Bootstrap Peer','workspace_bootstrap_peer','member',1)`).run();
  runtime.store.ensureAccountWorkspaces({ user: runtime.auth.getUser('workspace_bootstrap_peer') });
  runtime.store.ensureAccountWorkspaces({ user });
  runtime.store.switchAccountWorkspace({ userId: user.id, workspaceId: organizationWorkspaceId });

  const organizationBoot = await runtime.bootstrap();
  assert.equal(organizationBoot.activeAccountWorkspace?.id, organizationWorkspaceId);

  const aliasOrganizationId = 'org_workspace_bootstrap_alias';
  const aliasWorkspaceId = `workspace_org_${aliasOrganizationId}`;
  runtime.db.prepare(`INSERT INTO contact_organizations(
      id,organization_number,name,verification_code_salt,verification_code_hash,owner_user_id,source,remote_id
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
    aliasOrganizationId,
    'WORKSPACE-BOOTSTRAP-ALIAS',
    'Workspace Bootstrap Alias',
    'salt',
    'hash',
    user.id,
    'cloud',
    organizationId,
  );
  runtime.db.prepare(`INSERT INTO contact_organization_members(organization_id,user_id,role)
    VALUES(?,?,'owner')`).run(aliasOrganizationId, user.id);
  runtime.store.ensureAccountWorkspaces({ user });

  const relayRequests = { messages: [], delegations: [], collaboration: [] };
  const remoteOrganizationWorkspaceId = `workspace_org_${organizationId}`;
  const relay = new SocialRelayService({
    db: runtime.db,
    auth: {
      currentUser: () => user,
      decorateConversationGroups: (groups = []) => groups,
      importCloudFriendsOverview: () => {},
      upsertDelegationWorkspace: () => {},
    },
    client: {
      async messages(_state, payload) {
        relayRequests.messages.push({ workspaceId: payload.workspaceId, cursor: payload.cursor || '' });
        return { items: [], cursor: payload.workspaceId === 'workspace_personal' ? 'personal-next' : 'organization-next' };
      },
      async delegations(_state, payload) {
        relayRequests.delegations.push(payload.workspaceId);
        return {
          items: payload.workspaceId === remoteOrganizationWorkspaceId ? [{
            id: 'workspace-relay-org-delegation',
            workspaceId: remoteOrganizationWorkspaceId,
            requesterUserId: user.id,
            recipientUserId: 'workspace_bootstrap_peer',
            title: 'Organization-scoped relay delegation',
            instruction: 'Remain in the organization Workspace.',
            status: 'assigned',
          }] : [],
          cursor: '',
        };
      },
      async friends() { return {}; },
      async collaborationOverview(_state, payload) {
        relayRequests.collaboration.push(payload.workspaceId);
        if (payload.workspaceId === remoteOrganizationWorkspaceId) {
          return {
            groups: [{ id: 'workspace-relay-org-group', workspaceId: remoteOrganizationWorkspaceId, title: 'Organization group' }],
            tasks: [],
          };
        }
        const duplicate = { id: 'workspace-relay-personal-group', workspaceId: 'workspace_personal', title: 'Personal group' };
        return { groups: [duplicate, { ...duplicate }], tasks: [] };
      },
      async heartbeat() { return { ok: true }; },
    },
  });
  runtime.db.prepare(`UPDATE cloud_auth_state SET server_url='https://relay.invalid',enabled=1,
    access_token='relay-token',remote_user_id=?,last_social_message_cursors_json=?,updated_at=datetime('now') WHERE id='default'`)
    .run(user.id, JSON.stringify({ workspace_personal: 'personal-cursor', [remoteOrganizationWorkspaceId]: 'organization-cursor' }));
  const relayPoll = await relay.poll({ workspaceId: aliasWorkspaceId });
  assert.deepEqual(relayRequests.messages.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)), [
    { workspaceId: remoteOrganizationWorkspaceId, cursor: 'organization-cursor' },
    { workspaceId: 'workspace_personal', cursor: 'personal-cursor' },
  ].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)));
  assert.deepEqual(JSON.parse(runtime.db.prepare("SELECT last_social_message_cursors_json value FROM cloud_auth_state WHERE id='default'").get().value), {
    workspace_personal: 'personal-next', [remoteOrganizationWorkspaceId]: 'organization-next',
  });
  assert.deepEqual([...relayRequests.delegations].sort(), ['workspace_personal', remoteOrganizationWorkspaceId].sort());
  assert.deepEqual([...relayRequests.collaboration].sort(), ['workspace_personal', remoteOrganizationWorkspaceId].sort());
  assert.deepEqual(relayPoll.collaboration.groups.map((group) => group.id), ['workspace-relay-org-group']);
  assert.deepEqual(relayPoll.allWorkspaceCollaboration.groups.map((group) => group.id).sort(), [
    'workspace-relay-org-group',
    'workspace-relay-personal-group',
  ]);
  assert.equal(runtime.db.prepare('SELECT account_workspace_id FROM agent_delegations WHERE id=?')
    .get('workspace-relay-org-delegation')?.account_workspace_id, organizationWorkspaceId);
  runtime.db.prepare('DELETE FROM contact_organizations WHERE id=?').run(aliasOrganizationId);
  runtime.store.ensureAccountWorkspaces({ user });

  const boot = await runtime.runInCurrentAccountWorkspace(async () => {
    runtime.db.prepare('DELETE FROM contact_organizations WHERE id=?').run(organizationId);
    runtime.store.ensureAccountWorkspaces({ user });
    runtime.db.prepare(`UPDATE account_workspace_preferences
      SET active_workspace_id=?,updated_at=datetime('now') WHERE user_id=?`).run(organizationWorkspaceId, user.id);
    return runtime.bootstrap();
  });

  assert.equal(boot.activeAccountWorkspace?.id, 'workspace_personal');
  assert.equal(boot.accountWorkspaces.some((workspace) => workspace.id === organizationWorkspaceId), false);

  runtime.db.prepare(`UPDATE account_workspace_preferences
    SET active_workspace_id=?,updated_at=datetime('now') WHERE user_id=?`).run(organizationWorkspaceId, user.id);
  const scopedWorkspaceId = await runtime.runInCurrentAccountWorkspace(() => (
    runtime.store.activeAccountWorkspace({ userId: user.id })?.id
  ));
  assert.equal(scopedWorkspaceId, 'workspace_personal');
  assert.equal(runtime.db.prepare(`SELECT active_workspace_id FROM account_workspace_preferences
    WHERE user_id=? AND device_id=?`).get(user.id, runtime.store.contextDeviceId?.() || 'local')?.active_workspace_id, 'workspace_personal');

  console.log(JSON.stringify({ ok: true, activeWorkspaceId: boot.activeAccountWorkspace?.id }, null, 2));
} finally {
  try { await runtime?.close?.(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
