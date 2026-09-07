import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSyncV6Service } from '../cloud/src/modules/sync/syncV6.mjs';
import { CloudSyncService } from '../src/main/cloudSync.js';
import { openDatabase } from '../src/main/db.js';
import { DATABASE_MIGRATION_IDS } from '../src/main/modules/persistence/infrastructure/databaseMigrationRegistry.js';
import { Store } from '../src/main/store.js';
import {
  DATABASE_SYNC_BASE_CAPABILITIES,
  DATABASE_SYNC_BASE_PROTOCOL_VERSION,
  DATABASE_SYNC_CAPABILITIES,
  DATABASE_SYNC_MINIMUM_APP_VERSION,
  DATABASE_SYNC_PROTOCOL_VERSION,
  assessDatabaseClientCompatibility,
  createDatabaseClientContract,
  databaseContractFromQuery,
  databaseContractQuery,
} from '../src/shared/databaseEvolutionContract.js';

const clientContract = createDatabaseClientContract({
  appVersion: DATABASE_SYNC_MINIMUM_APP_VERSION,
  migrationIds: DATABASE_MIGRATION_IDS,
});
assert.equal(clientContract.syncProtocolVersion, DATABASE_SYNC_PROTOCOL_VERSION);
assert.deepEqual(clientContract.capabilities, [...DATABASE_SYNC_CAPABILITIES].sort());
assert.equal(assessDatabaseClientCompatibility(clientContract).compatible, true);

const roundTrip = databaseContractFromQuery(databaseContractQuery(clientContract));
assert.deepEqual(roundTrip, clientContract);
assert.deepEqual(assessDatabaseClientCompatibility({ ...clientContract, syncProtocolVersion: 5 }).reasons, ['sync_protocol_too_old']);
assert.deepEqual(assessDatabaseClientCompatibility({ ...clientContract, appVersion: '0.2.17' }).reasons, ['app_version_too_old']);
assert.ok(assessDatabaseClientCompatibility({ ...clientContract, capabilities: [] }).reasons
  .some((reason) => reason.startsWith('capability_missing:')));

const apiError = (code, message, status) => Object.assign(new Error(message), { code, status });
const pool = { query() { throw new Error('strict contract rejection must happen before database access'); } };
const defaultStrict = createSyncV6Service({ pool, apiError, env: {} });
assert.equal(defaultStrict.capabilities({}).databaseCompatibility.compatible, false,
  'a missing deployment flag must fail closed');
const strict = createSyncV6Service({ pool, apiError, env: { JANUS_SYNC_REQUIRE_CLIENT_CONTRACT: '1' } });
assert.equal(strict.capabilities({}).databaseCompatibility.compatible, false);
assert.equal(strict.capabilities(clientContract).databaseCompatibility.compatible, true);
const legacyV6Contract = {
  ...clientContract,
  syncProtocolVersion: DATABASE_SYNC_BASE_PROTOCOL_VERSION,
  capabilities: [...DATABASE_SYNC_BASE_CAPABILITIES],
};
assert.equal(strict.capabilities(legacyV6Contract).databaseCompatibility.compatible, false,
  'protocol 6 clients must be rejected before they can enter an Account-scoped stream');
await assert.rejects(strict.submitBatch({ userId: 'user', deviceId: 'device' }, {}),
  (error) => error.code === 'sync_client_contract_required' && error.status === 409);
await assert.rejects(strict.changes({ userId: 'user', deviceId: 'device' }, {}),
  (error) => error.code === 'sync_client_contract_required' && error.status === 409);
await assert.rejects(strict.submitBatch({ userId: 'user', deviceId: 'device' }, {
  clientContract: { ...clientContract, capabilities: [] },
}), (error) => error.code === 'sync_client_incompatible' && error.status === 409);
const preMessageBindingContract = {
  ...clientContract,
  capabilities: clientContract.capabilities.filter((capability) => capability !== 'message-memory-turn-binding-v1'),
};
assert.equal(strict.capabilities(preMessageBindingContract).databaseCompatibility.compatible, true,
  'expand phase must keep pre-message-binding clients compatible for non-message Sync');

const staged = createSyncV6Service({ pool, apiError, env: { JANUS_SYNC_REQUIRE_CLIENT_CONTRACT: '0' } });
assert.equal(staged.capabilities({}).databaseCompatibility.compatible, true,
  'staged rollout must allow legacy clients until the deployment switch is enabled');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-sync-contract-defer-'));
let db;
try {
  db = openDatabase(root, { appVersion: '0.2.18', skipMigrationBackup: true });
  db.prepare("INSERT INTO auth_users(id,email,display_name,remote_id) VALUES('contract_user','contract@example.com','Contract','remote_contract_user')").run();
  const store = new Store(db, { root });
  store.ensureAccountWorkspaces({ user: { id: 'contract_user', displayName: 'Contract' } });
  const desktop = new CloudSyncService({ root, db, store, defaultConfig: {} });
  assert.throws(() => desktop.applyV6Changes([{
    changeId: 'future_change', entityType: 'conversation', entityId: 'future_conversation', revision: 1,
    minimumProtocolVersion: DATABASE_SYNC_PROTOCOL_VERSION,
    requiredCapabilities: ['future-database-capability'],
    payload: { id: 'future_conversation', title: 'Future' },
  }], { remoteUserId: 'remote_contract_user' }), (error) => error.code === 'sync_client_incompatible');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM cloud_sync_v6_deferred_changes WHERE reason_code='client_database_contract_incompatible'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM cloud_sync_entity_revisions WHERE entity_type='conversation' AND entity_id='future_conversation'").get().count, 0,
    'an incompatible change must not be acknowledged locally');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sessions WHERE id='future_conversation'").get().count, 0);
  db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('contract_agent','Contract Agent','active',1,'employee',1)").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('contract_instance','contract_user','contract_agent','active')").run();
  const canonicalSession = store.createSession({
    title: 'Canonical contract chat', departmentId: 'general', agentId: 'contract_agent',
    agentInstanceId: 'contract_instance', userId: 'contract_user', accountWorkspaceId: 'workspace_personal',
  });
  db.prepare(`INSERT INTO sessions(id,conversation_id,user_id,account_workspace_id,title,department_id,agent_id,agent_instance_id,
    conversation_role,write_state,status) VALUES('contract_alias_chat','contract_alias_chat','contract_user','workspace_personal',
    'Alias contract chat','general','contract_agent','contract_instance','history','read_only','active')`).run();
  db.prepare(`INSERT INTO conversations(id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,status)
    VALUES('contract_alias_chat','workspace_personal','direct','contract_user','Alias contract chat','contract_agent','contract_instance','active')`).run();
  db.prepare(`INSERT INTO messages(id,account_workspace_id,conversation_id,session_id,role,content,agent_id,agent_instance_id)
    VALUES('contract_alias_message','workspace_personal','contract_alias_chat','contract_alias_chat','user','preserve alias message','contract_agent','contract_instance')`).run();
  const aliasChange = {
    changeId: 'contract_conversation_alias', entityType: 'conversation_alias', entityId: 'contract_alias_chat', revision: 1,
    minimumProtocolVersion: DATABASE_SYNC_PROTOCOL_VERSION,
    requiredCapabilities: ['agent-single-window-continuity-v1'],
    payload: {
      id: 'contract_alias_chat', alias_conversation_id: 'contract_alias_chat',
      canonical_conversation_id: canonicalSession.id, account_workspace_id: 'workspace_personal',
      conversation_kind: 'direct', agent_instance_id: 'contract_instance',
    },
  };
  db.prepare(`INSERT INTO conversation_aliases(alias_id,conversation_id,alias_kind,reason)
    VALUES('contract_alias_chat','contract_alias_chat','legacy_session','phase6_backfill')
    ON CONFLICT(alias_id) DO UPDATE SET conversation_id=excluded.conversation_id,reason=excluded.reason`).run();
  assert.equal(desktop.applyV6Changes([aliasChange], { remoteUserId: 'remote_contract_user' }).status, 'applied');
  assert.equal(db.prepare("SELECT conversation_id FROM conversation_aliases WHERE alias_id='contract_alias_chat'").get().conversation_id, canonicalSession.id);
  assert.equal(db.prepare("SELECT conversation_id FROM messages WHERE id='contract_alias_message'").get().conversation_id, canonicalSession.id);
  assert.equal(db.prepare("SELECT write_state FROM sessions WHERE id='contract_alias_chat'").get().write_state, 'read_only');
  const branchGeneration = Number(db.prepare(`SELECT thread_generation FROM agent_conversation_branch_state
    WHERE user_id='contract_user' AND account_workspace_id='workspace_personal' AND agent_instance_id='contract_instance'`).get().thread_generation);
  assert.equal(desktop.applyV6Changes([aliasChange], { remoteUserId: 'remote_contract_user' }).status, 'applied');
  assert.equal(Number(db.prepare(`SELECT thread_generation FROM agent_conversation_branch_state
    WHERE user_id='contract_user' AND account_workspace_id='workspace_personal' AND agent_instance_id='contract_instance'`).get().thread_generation), branchGeneration,
  'duplicate alias delivery must not advance the local thread generation');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM messages WHERE id='contract_alias_message'").get().count, 1);
  const localBatch = await desktop.buildBatchPayload({ ...desktop.state(), user_id: 'remote_contract_user', device_id: 'contract_device', last_sync_cursor: '' });
  assert.equal(localBatch.data.conversationAliases.some((item) => item.alias_conversation_id === 'contract_alias_chat'
    && item.canonical_conversation_id === canonicalSession.id), true);
  assert.throws(() => desktop.applyV6Changes([{
    ...aliasChange,
    changeId: 'contract_conversation_alias_cycle',
    entityId: canonicalSession.id,
    payload: {
      ...aliasChange.payload,
      id: canonicalSession.id,
      alias_conversation_id: canonicalSession.id,
      canonical_conversation_id: 'contract_alias_chat',
    },
  }], { remoteUserId: 'remote_contract_user' }), /conversation_alias_cycle/);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM cloud_sync_entity_revisions WHERE entity_type='conversation_alias' AND entity_id=?")
    .get(canonicalSession.id).count, 0, 'a rejected alias cycle must not be acknowledged locally');
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status,state_revision) VALUES('contract_instance_other','contract_user','contract_agent','active',1)").run();
  const reverseAgentAliases = [{
    changeId: 'contract_agent_alias_a', entityType: 'agent_instance_alias', entityId: 'contract_instance', revision: 1,
    payload: { alias_instance_id: 'contract_instance', canonical_instance_id: 'contract_instance_other', reason: 'historical_cycle' },
  }, {
    changeId: 'contract_agent_alias_b', entityType: 'agent_instance_alias', entityId: 'contract_instance_other', revision: 1,
    payload: { alias_instance_id: 'contract_instance_other', canonical_instance_id: 'contract_instance', reason: 'historical_cycle' },
  }];
  assert.equal(desktop.applyV6Changes(reverseAgentAliases, { remoteUserId: 'remote_contract_user' }).status, 'applied');
  assert.equal(db.prepare(`SELECT canonical_instance_id FROM user_agent_instance_aliases
    WHERE alias_instance_id='contract_instance_other'`).get().canonical_instance_id, 'contract_instance');
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM user_agent_instance_aliases WHERE alias_instance_id='contract_instance'").get().count), 0,
    'a normalized incoming Agent alias cycle must not leave a reverse canonical edge');
  db.prepare("INSERT OR IGNORE INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('ppt','PPT','active',1,'employee',1)").run();
  db.prepare("INSERT OR IGNORE INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('ppt_major_project','Legacy PPT','retired',0,'unavailable',0)").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status,state_revision) VALUES('contract_ppt_active','contract_user','ppt','active',2)").run();
  assert.equal(desktop.applyIdentitySnapshot({ status: 'ok', data: {
    userAgentInstances: [{
      id: 'contract_ppt_legacy', agent_family_id: 'ppt_major_project', status: 'inactive', state_revision: 1,
    }, {
      id: 'contract_ppt_active', agent_family_id: 'ppt', status: 'active', state_revision: 2,
    }],
    userAgentInstanceAliases: [{
      alias_instance_id: 'contract_ppt_legacy', canonical_instance_id: 'contract_ppt_active', reason: 'ppt_identity_migration',
    }],
  } }, { remoteUserId: 'remote_contract_user' }).status, 'applied');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM user_agent_instances WHERE id='contract_ppt_legacy'").get().count, 0,
    'a snapshot-retained legacy instance must remain alias history instead of replacing the active canonical instance');
  assert.equal(db.prepare("SELECT canonical_instance_id FROM user_agent_instance_aliases WHERE alias_instance_id='contract_ppt_legacy'").get().canonical_instance_id,
    'contract_ppt_active');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM user_agent_instance_aliases WHERE alias_instance_id='contract_ppt_active'").get().count, 0,
    'snapshot import must not create a transient active-to-legacy reverse alias');
  const staleContextMemory = store.ensureDefaultMemoryDocument({ agentInstanceId: 'contract_instance' });
  assert.ok(staleContextMemory?.contextSpaceId);
  db.prepare(`INSERT INTO agent_context_spaces(
    id,account_workspace_id,user_id,user_agent_instance_id,context_kind,memory_document_id,lifecycle_state
  ) VALUES('contract_context_semantic','workspace_personal','contract_user','contract_instance','general_memory','','active')`).run();
  db.prepare("UPDATE messages SET context_space_id='contract_context_semantic' WHERE id='contract_alias_message'").run();
  assert.equal(desktop.applyIdentitySnapshot({ status: 'ok', data: {
    agentContextSpaces: [{
      id: staleContextMemory.contextSpaceId, user_agent_instance_id: 'contract_instance',
      context_kind: 'general_memory', memory_document_id: '', lifecycle_state: 'active',
    }],
  } }, { remoteUserId: 'remote_contract_user' }).status, 'applied');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM agent_context_spaces WHERE id='contract_context_semantic'").get().count, 0,
    'a duplicate semantic context-space row must be merged after all references are rebound');
  assert.equal(db.prepare('SELECT memory_document_id FROM agent_context_spaces WHERE id=?').get(staleContextMemory.contextSpaceId).memory_document_id, '');
  assert.equal(db.prepare("SELECT context_space_id FROM messages WHERE id='contract_alias_message'").get().context_space_id,
    staleContextMemory.contextSpaceId);
  db.prepare(`INSERT INTO account_workspaces(id,workspace_kind,organization_id,owner_user_id,name,status)
    VALUES('contract_org_workspace','organization','contract_org','contract_user','Contract Org','active')`).run();
  db.prepare(`INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status)
    VALUES('contract_org_workspace','contract_user','owner','active')`).run();
  const organizationMemory = store.createMemoryDocument({
    agentInstanceId: 'contract_instance', workspaceId: 'contract_org_workspace', scope: 'general', slotNo: 0,
    displayName: 'organization-memory.md', content: 'Organization-only memory.',
  });
  db.prepare('UPDATE memory_documents SET cloud_key=? WHERE id=?').run(organizationMemory.id, staleContextMemory.id);
  assert.equal(desktop.applyIdentitySnapshot({ status: 'ok', data: {
    agentContextStates: [{
      user_agent_instance_id: 'contract_instance', active_memory_document_id: organizationMemory.id,
      active_context_space_id: organizationMemory.contextSpaceId, state_revision: 3,
    }],
  } }, { remoteUserId: 'remote_contract_user' }).status, 'applied');
  const scopedContextState = db.prepare(`SELECT active_memory_document_id,active_context_space_id FROM agent_context_state
    WHERE user_id='contract_user' AND account_workspace_id='workspace_personal' AND user_agent_instance_id='contract_instance'`).get();
  assert.equal(scopedContextState.active_memory_document_id, staleContextMemory.id,
    'Agent context Memory resolution must remain scoped to the Personal Workspace');
  const scopedContextSpace = db.prepare(`SELECT account_workspace_id,user_id,user_agent_instance_id
    FROM agent_context_spaces WHERE id=?`).get(scopedContextState.active_context_space_id);
  assert.equal(scopedContextSpace.account_workspace_id, 'workspace_personal');
  assert.equal(scopedContextSpace.user_id, 'contract_user');
  assert.equal(scopedContextSpace.user_agent_instance_id, 'contract_instance',
    'Agent context-space resolution must remain scoped to the Personal Workspace and canonical Agent');
  const retryFile = path.join(root, 'outputs', 'pending-file-retry.txt');
  fs.mkdirSync(path.dirname(retryFile), { recursive: true });
  fs.writeFileSync(retryFile, 'pending file retry\n');
  const retryHash = crypto.createHash('sha256').update(fs.readFileSync(retryFile)).digest('hex');
  const retryStat = fs.statSync(retryFile);
  db.prepare(`INSERT INTO cloud_file_manifest(local_path,sha256,size_bytes,mtime_ms,upload_status)
    VALUES('outputs/pending-file-retry.txt',?,?,?,'pending')`).run(retryHash, retryStat.size, Math.trunc(retryStat.mtimeMs));
  db.prepare(`INSERT INTO cloud_file_manifest(local_path,sha256,size_bytes,mtime_ms,upload_status)
    VALUES('artifacts/already-uploaded-copy.txt',?,?,?,'uploaded')`).run(retryHash, retryStat.size, Math.trunc(retryStat.mtimeMs));
  const referencedRetryFile = path.join(root, 'project-assets', 'referenced-pending-retry.txt');
  fs.mkdirSync(path.dirname(referencedRetryFile), { recursive: true });
  fs.writeFileSync(referencedRetryFile, 'referenced pending file retry\n');
  const referencedRetryHash = crypto.createHash('sha256').update(fs.readFileSync(referencedRetryFile)).digest('hex');
  const referencedRetryStat = fs.statSync(referencedRetryFile);
  db.prepare(`INSERT INTO cloud_file_manifest(local_path,sha256,size_bytes,mtime_ms,upload_status)
    VALUES('project-assets/referenced-pending-retry.txt',?,?,?,'pending')`).run(
    referencedRetryHash, referencedRetryStat.size, Math.trunc(referencedRetryStat.mtimeMs),
  );
  const retryFiles = await desktop.scanOutputFiles([], { cursor: '2099-01-01T00:00:00.000Z' });
  assert.equal(retryFiles.some((file) => file.localPath === 'outputs/pending-file-retry.txt'), true,
    'unchanged pending files must remain eligible for retry after the sync cursor advances');
  assert.equal(retryFiles.some((file) => file.localPath === 'project-assets/referenced-pending-retry.txt'), true,
    'pending referenced files must retry even when their source message predates the sync cursor');
  desktop.client.initiateV6File = async () => ({ status: 'already_uploaded' });
  assert.equal(await desktop.uploadFilesV6({}, retryFiles), 2);
  assert.equal(db.prepare("SELECT upload_status FROM cloud_file_manifest WHERE local_path='outputs/pending-file-retry.txt'").get().upload_status,
    'uploaded', 'an already-uploaded hash must reconcile every matching local manifest row');
  db.prepare(`INSERT INTO cloud_file_refs(
    id,local_path,sha256,user_id,relation_type,source_kind,original_name,content_type,size_bytes
  ) VALUES('contract_deleted_file_ref','outputs/pending-file-retry.txt',?,'contract_user','output','agent_output',
    'pending-file-retry.txt','text/plain',?)`).run(retryHash, retryStat.size);
  assert.equal(desktop.applyV6Changes([{
    changeId: 'contract_deleted_file_ref_change', entityType: 'file_ref', entityId: 'contract_deleted_file_ref',
    operation: 'delete', revision: 2, payload: { id: 'contract_deleted_file_ref', sha256: retryHash },
  }], { remoteUserId: 'remote_contract_user' }).status, 'applied');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM cloud_file_refs WHERE id='contract_deleted_file_ref'").get().count, 0,
    'a cloud file-ref tombstone must remove only the local reference metadata');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM cloud_file_manifest WHERE local_path='outputs/pending-file-retry.txt'").get().count, 1,
    'file-ref deletion must not delete the local file manifest or file bytes');
  desktop.close();
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write('Database sync contract smoke passed.\n');
