import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuthService } from '../src/main/auth.js';
import { openDatabase } from '../src/main/db.js';
import { Store } from '../src/main/store.js';
import { AgentExecutionCoordinator } from '../src/main/modules/orchestration/application/agentExecutionCoordinator.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-account-workspace-'));
let db;
try {
  db = openDatabase(root, { skipMigrationBackup: true });
  const auth = new AuthService(db);
  const store = new Store(db, { root });
  const owner = auth.currentUser();
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,role,email_verified)
    VALUES('workspace_peer','peer@workspace.test','Workspace Peer','workspace_peer','admin',1)`).run();
  const peer = auth.getUser('workspace_peer');
  store.ensureAccountWorkspaces({ user: owner });
  store.ensureAccountWorkspaces({ user: peer });

  db.prepare(`INSERT INTO contact_organizations(id,organization_number,name,verification_code_salt,verification_code_hash,owner_user_id)
    VALUES('org_workspace_smoke','WORKSPACE-SMOKE','Workspace Smoke','salt','hash',?)`).run(owner.id);
  db.prepare(`INSERT INTO contact_organization_members(organization_id,user_id,role)
    VALUES('org_workspace_smoke',?,'owner'),('org_workspace_smoke',?,'member')`).run(owner.id, peer.id);
  store.ensureAccountWorkspaces({ user: owner });
  store.ensureAccountWorkspaces({ user: peer });
  const organizationWorkspaceId = 'workspace_org_org_workspace_smoke';
  assert.equal(store.listAccountWorkspaces({ userId: owner.id }).length, 2);

  store.switchAccountWorkspace({ userId: owner.id, workspaceId: 'workspace_personal' });
  db.prepare('DELETE FROM account_workspace_startup_preferences WHERE user_id=?').run(owner.id);
  assert.equal(store.startupAccountWorkspace({ userId: owner.id }).id, 'workspace_personal',
    'without an explicit startup preference, restart must preserve the last active Workspace');
  assert.equal(store.applyStartupAccountWorkspace({ userId: owner.id }).id, 'workspace_personal');
  assert.equal(db.prepare('SELECT startup_workspace_id FROM account_workspace_startup_preferences WHERE user_id=?').get(owner.id), undefined,
    'an inferred startup Workspace must not become a sticky preference');
  store.setStartupAccountWorkspace({ userId: owner.id, workspaceId: organizationWorkspaceId });
  assert.equal(store.applyStartupAccountWorkspace({ userId: owner.id }).id, organizationWorkspaceId,
    'an explicit startup preference must still be honored');
  db.prepare('DELETE FROM account_workspace_startup_preferences WHERE user_id=?').run(owner.id);
  store.switchAccountWorkspace({ userId: owner.id, workspaceId: 'workspace_personal' });

  db.prepare(`INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable)
    VALUES('workspace_agent','Workspace Agent','active',1,'employee',1)`).run();
  db.prepare(`INSERT INTO agent_versions(id,agent_family_id,content_hash,status)
    VALUES('workspace_agent_v1','workspace_agent','workspace-agent-v1','active')`).run();
  db.prepare("UPDATE agent_families SET current_version_id='workspace_agent_v1' WHERE id='workspace_agent'").run();
  db.prepare(`INSERT INTO user_agent_instances(id,user_id,agent_family_id,base_agent_version_id,status,employment_state,display_name)
    VALUES('workspace_agent_instance',?,'workspace_agent','workspace_agent_v1','active','active','Workspace Agent A')`).run(owner.id);

  store.switchAccountWorkspace({ userId: owner.id, workspaceId: 'workspace_personal' });
  const personalSession = store.createSession({ userId: owner.id, title: 'Personal Agent', agentId: 'workspace_agent',
    agentInstanceId: 'workspace_agent_instance' });
  db.prepare(`INSERT OR IGNORE INTO agent_families(id,name,status,routable,instance_kind,recruitable)
    VALUES('secretary_agent','私人助理','active',1,'secretary',0)`).run();
  db.prepare("UPDATE agent_families SET status='active',routable=1,instance_kind='system' WHERE id='secretary_agent'").run();
  db.prepare(`INSERT OR IGNORE INTO agent_versions(id,agent_family_id,content_hash,status)
    VALUES('workspace_secretary_v1','secretary_agent','workspace-secretary-v1','active')`).run();
  db.prepare("UPDATE agent_families SET current_version_id=COALESCE(NULLIF(current_version_id,''),'workspace_secretary_v1') WHERE id='secretary_agent'").run();
  db.prepare(`INSERT OR IGNORE INTO user_agent_instances(
    id,user_id,agent_family_id,base_agent_version_id,status,employment_state,display_name
  ) VALUES('workspace_secretary_instance',?,'secretary_agent','workspace_secretary_v1','active','active','私人助理')`).run(owner.id);
  db.prepare(`UPDATE user_agent_instances SET status='active',employment_state='active',instance_kind='system',
    base_agent_version_id=COALESCE(NULLIF(base_agent_version_id,''),'workspace_secretary_v1')
    WHERE user_id=? AND agent_family_id='secretary_agent'`).run(owner.id);
  const secretaryInstance = db.prepare(`SELECT id FROM user_agent_instances
    WHERE user_id=? AND agent_family_id='secretary_agent' AND status='active' ORDER BY created_at LIMIT 1`).get(owner.id);
  assert.ok(secretaryInstance?.id, 'private assistant instance must exist');
  const personalSecretarySession = store.createSession({ userId: owner.id, title: 'Personal Private Assistant',
    departmentId: 'secretary_department', agentId: 'secretary_agent', agentInstanceId: secretaryInstance.id });
  const personalSecretaryMemory = store.createAndActivateGeneralMemory({ agentInstanceId: secretaryInstance.id, content: 'personal-private-assistant-only' });
  const personalMemory = store.createAndActivateGeneralMemory({ agentInstanceId: 'workspace_agent_instance', content: 'personal-only' });
  const personalTask = store.createTaskRun({ ownerUserId: owner.id, title: 'Personal Task', prompt: 'personal task',
    leadAgentId: 'workspace_agent', leadAgentInstanceId: 'workspace_agent_instance' });

  store.switchAccountWorkspace({ userId: owner.id, workspaceId: organizationWorkspaceId });
  const organizationSession = store.createSession({ userId: owner.id, title: 'Organization Agent', agentId: 'workspace_agent',
    agentInstanceId: 'workspace_agent_instance' });
  const organizationSecretarySession = store.createSession({ userId: owner.id, title: 'Organization Private Assistant',
    departmentId: 'secretary_department', agentId: 'secretary_agent', agentInstanceId: secretaryInstance.id });
  const organizationSecretaryMemory = store.createAndActivateGeneralMemory({ agentInstanceId: secretaryInstance.id, content: 'organization-private-assistant-only' });
  const organizationMemory = store.createAndActivateGeneralMemory({ agentInstanceId: 'workspace_agent_instance', content: 'organization-only' });
  const organizationTask = store.createTaskRun({ ownerUserId: owner.id, workspaceId: organizationWorkspaceId,
    title: 'Organization Task', prompt: 'organization task', leadAgentId: 'workspace_agent', leadAgentInstanceId: 'workspace_agent_instance' });
  const personalWindowMessage = store.addMessage({
    sessionId: personalSession.id, role: 'user', content: 'PERSONAL_WINDOW_MESSAGE',
    agentId: 'workspace_agent', agentInstanceId: 'workspace_agent_instance', departmentId: 'general',
  });
  const organizationWindowMessage = store.addMessage({
    sessionId: organizationSession.id, role: 'assistant', content: 'ORGANIZATION_WINDOW_MESSAGE',
    agentId: 'workspace_agent', agentInstanceId: 'workspace_agent_instance', departmentId: 'general',
  });
  const organizationLatestMessage = store.addMessage({
    sessionId: organizationSession.id, role: 'user', content: 'ORGANIZATION_LATEST_WINDOW_MESSAGE',
    agentId: 'workspace_agent', agentInstanceId: 'workspace_agent_instance', departmentId: 'general',
  });
  db.prepare('UPDATE messages SET created_at=? WHERE id=?').run('2026-08-07T09:00:00.000Z', personalWindowMessage.id);
  db.prepare('UPDATE messages SET created_at=? WHERE id=?').run('2026-08-07T09:01:00.000Z', organizationWindowMessage.id);
  db.prepare('UPDATE messages SET created_at=? WHERE id=?').run('2026-08-07T09:02:00.000Z', organizationLatestMessage.id);

  assert.notEqual(personalSession.id, organizationSession.id);
  assert.equal(personalSession.workspaceId, 'workspace_personal');
  assert.equal(organizationSession.workspaceId, organizationWorkspaceId);
  assert.notEqual(personalMemory.id, organizationMemory.id);
  assert.notEqual(personalSecretarySession.id, organizationSecretarySession.id);
  assert.notEqual(personalSecretaryMemory.id, organizationSecretaryMemory.id);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM workspace_agent_bindings
    WHERE workspace_id IN (?,?) AND agent_instance_id=? AND status='active'`).get(
    'workspace_personal', organizationWorkspaceId, 'workspace_agent_instance',
  ).count, 2, 'a personal Agent must be bound independently when used in multiple Workspaces');
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM workspace_agent_bindings
    WHERE workspace_id IN (?,?) AND agent_instance_id=? AND status='active'`).get(
    'workspace_personal', organizationWorkspaceId, secretaryInstance.id,
  ).count, 2, 'private assistant usage must create separate Workspace bindings');
  const branches = store.listAgentConversationBranches({ userId: owner.id, agentInstanceId: 'workspace_agent_instance' });
  assert.deepEqual(branches.map((item) => item.workspaceId).sort(), ['workspace_personal', organizationWorkspaceId].sort());
  const agentTimeline = store.listAgentConversationTimeline({ userId: owner.id, agentInstanceId: 'workspace_agent_instance' });
  assert.equal(agentTimeline.windowId, `account:${organizationWorkspaceId}:agent:workspace_agent_instance`);
  assert.equal(agentTimeline.items.some((item) => item.content === 'PERSONAL_WINDOW_MESSAGE'), false);
  assert.equal(agentTimeline.items.some((item) => item.content === 'ORGANIZATION_WINDOW_MESSAGE' && item.accessState === 'full'), true);
  assert.deepEqual(store.listMessagesForPrompt(personalSession.id, { ownerUserId: owner.id }).map((item) => item.content), ['PERSONAL_WINDOW_MESSAGE']);
  assert.deepEqual(store.listMessagesForPrompt(organizationSession.id, { ownerUserId: owner.id }).map((item) => item.content), [
    'ORGANIZATION_WINDOW_MESSAGE',
    'ORGANIZATION_LATEST_WINDOW_MESSAGE',
  ]);
  assert.equal(store.resolveMemoryContext({ agentInstanceId: secretaryInstance.id }).content.includes('organization-private-assistant-only'), true);
  assert.equal(store.resolveMemoryContext({ agentInstanceId: secretaryInstance.id }).content.includes('personal-private-assistant-only'), false);
  assert.equal(store.resolveMemoryContext({ agentInstanceId: 'workspace_agent_instance' }).content.includes('organization-only'), true);
  assert.equal(store.resolveMemoryContext({ agentInstanceId: 'workspace_agent_instance' }).content.includes('personal-only'), false);
  const organizationSessions = store.listSessions({ user: owner });
  assert.deepEqual(organizationSessions.map((item) => item.id).sort(), [organizationSession.id, organizationSecretarySession.id].sort());
  const organizationSessionPreview = organizationSessions.find((item) => item.id === organizationSession.id);
  assert.equal(organizationSessionPreview.lastMessage, 'ORGANIZATION_LATEST_WINDOW_MESSAGE');
  assert.equal(organizationSessionPreview.lastMessageRole, 'user');
  assert.equal(organizationSessionPreview.lastMessageAt, '2026-08-07T09:02:00.000Z');
  assert.equal(organizationSessions.some((item) => item.lastMessage === 'PERSONAL_WINDOW_MESSAGE'), false,
    'Session previews must remain scoped to the active account Workspace');
  assert.deepEqual(store.listTaskRuns({ userId: owner.id }).map((item) => item.id), [organizationTask.id]);

  db.prepare(`INSERT INTO friendships(id,user_a_id,user_b_id,status) VALUES('workspace_friend',?,?,'accepted')`).run(owner.id, peer.id);
  auth.socialSendMessage({ recipientId: peer.id, content: 'organization message', workspaceId: organizationWorkspaceId });
  assert.equal(auth.socialConversation({ peerId: peer.id, workspaceId: organizationWorkspaceId }).length, 1);
  assert.equal(auth.socialConversation({ peerId: peer.id, workspaceId: 'workspace_personal' }).length, 0);
  const delegation = auth.createAgentDelegation({ recipientId: peer.id, title: 'Organization Delegation', instruction: 'organization only',
    workspaceId: organizationWorkspaceId }).delegation;
  assert.equal(delegation.workspaceId, organizationWorkspaceId);
  const group = auth.createCollaborationGroup({ title: 'Organization Group', workspaceId: organizationWorkspaceId,
    assignments: [{ recipientId: peer.id, title: 'Member Task', instruction: 'handle organization task' }] });
  assert.equal(group.group.workspaceId, organizationWorkspaceId);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM collaboration_group_messages WHERE account_workspace_id=?').get(organizationWorkspaceId).count >= 2, true);
  auth.socialSendMessage({ recipientId: peer.id, content: 'personal message', workspaceId: 'workspace_personal' });
  assert.equal(auth.socialConversation({ peerId: peer.id, workspaceId: 'workspace_personal' }).length, 1);

  const workspaceExecution = new AsyncLocalStorage();
  store.accountWorkspaceContext = () => workspaceExecution.getStore()?.workspaceId || '';
  auth.accountWorkspaceContext = store.accountWorkspaceContext;
  const coordinator = new AgentExecutionCoordinator({ store });
  coordinator.setWorkspaceRunner((workspaceId, operation) => workspaceExecution.run({ workspaceId }, operation));
  coordinator.registerHandler('workspace_smoke', async (work) => {
    await new Promise((resolve) => setImmediate(resolve));
    const session = store.createSession({
      userId: owner.id,
      title: 'Background Organization Agent',
      agentId: 'workspace_agent',
      agentInstanceId: 'workspace_agent_instance',
    });
    const task = store.createTaskRun({
      ownerUserId: owner.id,
      title: 'Background Organization Task',
      prompt: 'must remain in the captured Workspace',
      leadAgentId: 'workspace_agent',
      leadAgentInstanceId: 'workspace_agent_instance',
    });
    const backgroundDelegation = auth.createAgentDelegation({
      recipientId: peer.id,
      title: 'Background Organization Delegation',
      instruction: 'must remain in the captured Workspace',
    }).delegation;
    return { session, task, delegation: backgroundDelegation, work };
  });
  store.switchAccountWorkspace({ userId: owner.id, workspaceId: 'workspace_personal' });
  coordinator.start();
  const queued = coordinator.enqueue({
    userId: owner.id,
    agentInstanceId: 'workspace_agent_instance',
    workKind: 'workspace_smoke',
    workId: 'workspace_background_capture',
    workspaceId: organizationWorkspaceId,
  });
  const background = await coordinator.waitForWork(queued.id);
  coordinator.stop();
  assert.equal(background.session.workspaceId, organizationWorkspaceId);
  assert.equal(background.task.workspaceId, organizationWorkspaceId);
  assert.equal(background.delegation.workspaceId, organizationWorkspaceId);
  assert.equal(store.activeAccountWorkspace({ userId: owner.id }).id, 'workspace_personal');
  const backgroundUpdatedOutsideWorkspace = auth.updateAgentDelegation({
    delegationId: background.delegation.id,
    metadata: { backgroundUpdateAfterWorkspaceSwitch: true },
  });
  assert.equal(backgroundUpdatedOutsideWorkspace.workspaceId, organizationWorkspaceId);
  assert.equal(backgroundUpdatedOutsideWorkspace.metadata.backgroundUpdateAfterWorkspaceSwitch, true);
  assert.equal(auth.agentDelegations({ direction: 'all', workspaceId: 'workspace_personal' })
    .some((item) => item.id === background.delegation.id), false);
  assert.equal(auth.agentDelegationsAllWorkspaces({ direction: 'all' })
    .some((item) => item.id === background.delegation.id), true);

  assert.deepEqual(store.listSessions({ user: owner }).map((item) => item.id).sort(), [personalSession.id, personalSecretarySession.id].sort());
  assert.deepEqual(store.listTaskRuns({ userId: owner.id }).map((item) => item.id), [personalTask.id]);
  assert.equal(store.resolveMemoryContext({ agentInstanceId: 'workspace_agent_instance' }).content.includes('personal-only'), true);
  assert.equal(store.resolveMemoryContext({ agentInstanceId: 'workspace_agent_instance' }).content.includes('organization-only'), false);
  assert.equal(store.resolveMemoryContext({ agentInstanceId: secretaryInstance.id }).content.includes('personal-private-assistant-only'), true);
  assert.equal(store.resolveMemoryContext({ agentInstanceId: secretaryInstance.id }).content.includes('organization-private-assistant-only'), false);
  assert.equal(auth.canAccessSession(peer, personalSession), false, 'platform admin must not bypass session ownership');

  db.prepare("UPDATE account_workspace_memberships SET status='left' WHERE workspace_id=? AND user_id=?").run(organizationWorkspaceId, owner.id);
  const redactedTimeline = store.listAgentConversationTimeline({ userId: owner.id, agentInstanceId: 'workspace_agent_instance' });
  assert.equal(redactedTimeline.items.some((item) => item.workspaceId === organizationWorkspaceId), false);
  assert.equal(redactedTimeline.items.some((item) => item.workspaceId === 'workspace_personal'
    && item.accessState === 'full' && item.content === 'PERSONAL_WINDOW_MESSAGE'), true);
  assert.throws(() => store.switchAccountWorkspace({ userId: owner.id, workspaceId: organizationWorkspaceId }), /工作空间不存在|不在该工作空间/);
  db.prepare('DELETE FROM contact_organizations WHERE id=?').run('org_workspace_smoke');
  db.prepare('DELETE FROM account_workspace_preferences WHERE user_id=?').run(owner.id);
  db.prepare(`INSERT INTO account_workspace_preferences(user_id,device_id,active_workspace_id,updated_at)
    VALUES(?,?,?,datetime('now'))`).run(owner.id, 'stale_remote_device', organizationWorkspaceId);
  store.ensureAccountWorkspaces({ user: owner });
  assert.equal(db.prepare('SELECT active_workspace_id FROM account_workspace_preferences WHERE user_id=? AND device_id=?')
    .get(owner.id, 'stale_remote_device')?.active_workspace_id, 'workspace_personal');

  const setStaleRemotePreference = () => {
    db.prepare('DELETE FROM account_workspace_preferences WHERE user_id=?').run(owner.id);
    db.prepare(`INSERT INTO account_workspace_preferences(user_id,device_id,active_workspace_id,updated_at)
      VALUES(?,?,?,datetime('now'))`).run(owner.id, 'stale_remote_device', organizationWorkspaceId);
  };
  for (const implicitRead of [
    () => auth.friendsOverview(),
    () => auth.agentDelegations(),
    () => auth.collaborationOverview(),
  ]) {
    setStaleRemotePreference();
    assert.doesNotThrow(implicitRead);
    assert.equal(db.prepare('SELECT active_workspace_id FROM account_workspace_preferences WHERE user_id=? AND device_id=?')
      .get(owner.id, 'stale_remote_device')?.active_workspace_id, 'workspace_personal');
  }
  assert.throws(() => auth.friendsOverview({ workspaceId: organizationWorkspaceId }), /工作空间不存在|不在该工作空间/);
  assert.throws(() => auth.agentDelegations({ workspaceId: organizationWorkspaceId }), /工作空间不存在|不在该工作空间/);
  assert.throws(() => auth.collaborationOverview({ workspaceId: organizationWorkspaceId }), /工作空间不存在|不在该工作空间/);
  store.ensureAccountWorkspaces({ user: owner });
  assert.equal(db.prepare('SELECT status FROM account_workspaces WHERE id=?').get(organizationWorkspaceId)?.status, 'deleted');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM account_workspace_memberships WHERE workspace_id=? AND status=?')
    .get(organizationWorkspaceId, 'removed').count >= 1, true);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  console.log(JSON.stringify({ ok: true, personalSessionId: personalSession.id, organizationSessionId: organizationSession.id,
    personalMemoryId: personalMemory.id, organizationMemoryId: organizationMemory.id }, null, 2));
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
