import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CloudSyncService } from '../src/main/cloudSync.js';
import { openDatabase } from '../src/main/db.js';
import { Store } from '../src/main/store.js';

await verifyHistoricalOutboxSchedulingUpgrade();

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-evidence-outbox-'));
let db;
let sync;

try {
  db = openDatabase(root);
  const store = new Store(db, { root });
  db.prepare(`INSERT INTO auth_users (id,email,display_name,username,role,remote_id,email_verified)
    VALUES ('outbox_local','outbox@example.com','Outbox User','outbox_user','member','outbox_remote',1)`).run();
  store.upsertAgentFamily({ id: 'outbox_family', name: 'Outbox Agent', departmentId: 'general', role: 'agent', routable: true });
  store.upsertAgentVersion({
    agent: { id: 'outbox_family', name: 'Outbox Agent', departmentId: 'general', role: 'agent', baseSkill: '# Outbox Skill\n' },
    memoryTemplate: '# Memory\n',
  });
  const instance = store.recruitUserAgent({ userId: 'outbox_local', agentFamilyId: 'outbox_family', commandId: 'outbox_recruit' }).instance;
  store.updateUserAgentConsents({ agentInstanceId: instance.id, syncEnabled: true, personalEvolutionConsent: true });
  const session = store.createSession({
    title: 'Evidence outbox', userId: 'outbox_local', agentId: 'outbox_family', agentInstanceId: instance.id, departmentId: 'general',
  });

  const originalRecordOutbox = store.recordEvolutionEvidenceOutbox;
  const beforeRollbackMessages = db.prepare('SELECT COUNT(*) AS count FROM messages').get().count;
  store.recordEvolutionEvidenceOutbox = () => { throw new Error('injected outbox failure'); };
  assert.throws(() => store.addMessage({
    sessionId: session.id, role: 'user', content: 'must roll back', agentId: 'outbox_family', agentInstanceId: instance.id,
  }), /injected outbox failure/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, beforeRollbackMessages);
  store.recordEvolutionEvidenceOutbox = originalRecordOutbox;

  const message = store.addMessage({
    sessionId: session.id, role: 'user', content: 'first message version', agentId: 'outbox_family', agentInstanceId: instance.id,
  });
  assert.equal(outboxCount(db, 'message', message.id), 1);
  store.updateMessage(message.id, { content: 'first message version' });
  assert.equal(outboxCount(db, 'message', message.id), 1, 'unchanged message content must stay idempotent');
  store.updateMessage(message.id, { content: 'second message version' });
  assert.equal(outboxCount(db, 'message', message.id), 2, 'changed message content must create a new stable Evidence record');
  const firstAssistant=store.addMessage({sessionId:session.id,role:'assistant',content:'first assistant reply',agentId:'outbox_family',agentInstanceId:instance.id});
  store.addMessage({sessionId:session.id,role:'assistant',content:'second assistant reply',agentId:'outbox_family',agentInstanceId:instance.id});
  assert.equal(outboxCount(db,'conversation_segment',session.id),1,'only the first assistant reply after a user message may form a conversation segment');

  const memory = store.listMemoryDocuments({ agentInstanceId: instance.id }).find((item) => item.scope === 'general');
  assert.ok(memory);
  assert.equal(outboxCount(db, 'memory_version', memory.id), 1, 'initial Memory version must be captured');
  const beforeMemoryVersions = db.prepare('SELECT COUNT(*) AS count FROM memory_document_versions WHERE memory_document_id=?').get(memory.id).count;
  store.recordEvolutionEvidenceOutbox = () => { throw new Error('injected Memory outbox failure'); };
  assert.throws(() => store.appendMemoryDocumentVersion({ memoryDocumentId: memory.id, content: '# rolled back Memory\n' }), /injected Memory outbox failure/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_document_versions WHERE memory_document_id=?').get(memory.id).count, beforeMemoryVersions);
  store.recordEvolutionEvidenceOutbox = originalRecordOutbox;
  store.appendMemoryDocumentVersion({ memoryDocumentId: memory.id, content: '# Memory v2\n', sourceKind: 'user_edit' });
  assert.equal(outboxCount(db, 'memory_version', memory.id), 2);

  const task = store.createTaskRun({
    title: 'Outbox task', prompt: 'Exercise every terminal task Evidence type.', departmentId: 'general',
    leadAgentId: 'outbox_family', leadAgentInstanceId: instance.id, ownerUserId: 'outbox_local',
  });
  const node = store.createTaskNode({
    taskRunId: task.id, title: 'Outbox node', objective: 'Produce terminal Evidence.', departmentId: 'general',
    agentId: 'outbox_family', agentInstanceId: instance.id, status: 'running',
  });
  const encryptedTaskMemoryOutbox = db.prepare(`SELECT snapshot_json FROM evolution_evidence_outbox
    WHERE source_kind='memory_version' AND task_run_id=? ORDER BY created_at DESC LIMIT 1`).get(task.id);
  assert.ok(encryptedTaskMemoryOutbox);
  const encryptedTaskMemorySnapshot = JSON.parse(encryptedTaskMemoryOutbox.snapshot_json);
  assert.ok(encryptedTaskMemorySnapshot.encryptedSource);
  assert.equal(Object.hasOwn(encryptedTaskMemorySnapshot, 'content'), false, 'task Memory plaintext must not be duplicated into the outbox snapshot');
  const beforeTaskEvents = db.prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_node_id=?').get(node.id).count;
  store.recordEvolutionEvidenceOutbox = () => { throw new Error('injected task outbox failure'); };
  assert.throws(() => store.updateTaskNode(node.id, { status: 'completed', resultText: 'rolled back result' }), /injected task outbox failure/);
  assert.equal(store.getTaskNode(node.id).status, 'running');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_node_id=?').get(node.id).count, beforeTaskEvents);
  store.recordEvolutionEvidenceOutbox = originalRecordOutbox;
  for (const status of ['completed', 'accepted', 'rework', 'failed', 'blocked', 'cancelled']) {
    store.updateTaskNode(node.id, {
      status,
      resultText: status === 'completed' ? 'completed result' : '',
      resultSummary: `${status} summary`,
      errorText: status === 'failed' ? 'expected failure' : '',
      waitReason: status === 'blocked' ? 'dependency unavailable' : '',
      completedAt: new Date().toISOString(),
    });
  }
  for (const sourceKind of ['task_result', 'task_acceptance', 'task_rework', 'task_failure', 'task_blocked', 'task_cancelled']) {
    assert.equal(outboxCount(db, sourceKind, node.id), 1, `${sourceKind} must have one terminal task event Evidence record`);
  }

  const execution = store.beginModelExecution({
    userId: 'outbox_local', conversationId: session.id, agentId: 'outbox_family', agentInstanceId: instance.id,
    executionKind: 'chat', providerId: 'fake', requestedModel: 'fake-model', effectiveModel: 'fake-model',
  });
  store.completeModelExecution(execution.id, { status: 'completed' });
  store.updateModelExecution(execution.id, { responseMessageId: message.id });
  assert.equal(outboxCount(db, 'model_execution', execution.id), 1, 'a model execution must be captured only on its first terminal transition');
  assert.equal(outboxCount(db, 'model_execution_metric', execution.id), 1, 'a terminal model execution must create a distinct metric Evidence record');

  store.upsertAgentFamily({ id: 'secretary_agent', name: 'Secretary', departmentId: 'general', role: 'agent', routable: true });
  store.upsertAgentVersion({agent:{id:'secretary_agent',name:'Secretary',departmentId:'general',role:'agent',baseSkill:'# Secretary\n'},memoryTemplate:'# Memory\n'});
  const secretaryVersion=db.prepare("SELECT id FROM agent_versions WHERE agent_family_id='secretary_agent' AND status='active' ORDER BY created_at DESC LIMIT 1").get();
  db.prepare(`INSERT OR IGNORE INTO user_agent_instances
    (id,user_id,agent_family_id,base_agent_version_id,status,employment_state,sync_enabled,personal_evolution_consent,recruited_at,last_state_changed_at)
    VALUES('secretary_instance','outbox_local','secretary_agent',?,'active','active',1,1,?,?)`).run(secretaryVersion?.id||'',new Date().toISOString(),new Date().toISOString());
  const secretary=store.findUserAgentInstance({userId:'outbox_local',agentFamilyId:'secretary_agent'});
  assert.ok(secretary);
  store.updateUserAgentConsents({agentInstanceId:secretary.id,syncEnabled:true,personalEvolutionConsent:true});
  db.prepare("INSERT INTO collaboration_groups(id,owner_user_id,title) VALUES('legacy_group','outbox_local','Legacy Group')").run();
  db.prepare(`INSERT INTO collaboration_group_messages(id,group_id,sender_user_id,sender_agent_id,kind,content,created_at)
    VALUES('legacy_group_message','legacy_group','outbox_local','secretary_agent','agent','legacy collaboration evidence','2000-01-01T00:00:01.000Z')`).run();
  db.prepare(`INSERT INTO agent_delegations(id,requester_user_id,recipient_user_id,title,status,group_id,created_at,updated_at)
    VALUES('legacy_delegation','outbox_local','remote_friend','Legacy delegation','accepted','legacy_group','2000-01-01T00:00:02.000Z','2000-01-01T00:00:02.000Z')`).run();
  db.prepare(`INSERT INTO agent_delegation_revisions(id,delegation_id,author_user_id,revision_no,action,content,created_at)
    VALUES('legacy_revision','legacy_delegation','outbox_local',1,'submit','legacy delegation result','2000-01-01T00:00:03.000Z')`).run();

  let uploadCalls = 0;
  let lastUploadedItems=[];
  const client = {
    async uploadEvolutionEvidence(_state, items) {
      uploadCalls += 1;
      lastUploadedItems=items;
      if (uploadCalls === 1) throw new Error('temporary upload outage');
      return {
        status: 'accepted', accepted: items.map((item) => item.evidenceId), duplicates: [], quarantined: [], rejected: [],
        results: [...items].reverse().map((item) => ({
          clientRecordId: item.clientRecordId, evidenceId: item.evidenceId, sourceKind: item.sourceKind,
          sourceId: item.sourceId, sourceVersionId: item.sourceVersionId, status: 'accepted', retryable: false,
        })),
      };
    },
  };
  sync = new CloudSyncService({
    root, db, store, client, defaultConfig: { serverUrl: 'http://outbox.invalid', token: 'outbox-token', autoSync: false },
  });
  sync.saveConfig({
    serverUrl: 'http://outbox.invalid', token: 'outbox-token', autoSync: false, userId: 'outbox_remote', deviceId: 'outbox_device',
  });
  sync.ensureEvolutionGrant = async () => 'test-grant';

  const legacyMessageId = 'legacy_message_without_outbox';
  db.prepare(`INSERT INTO messages (id,session_id,role,content,agent_id,agent_instance_id,department_id,visible,created_at)
    VALUES (?,?, 'assistant','legacy cursor evidence','outbox_family',?,'general',1,'2000-01-01T00:00:00.000Z')`).run(
    legacyMessageId, session.id, instance.id,
  );
  assert.equal(sync.enqueueEvolutionEvidence().queued, 3, 'historical message, collaboration, and delegation rows must remain backfill-compatible');
  assert.equal(sync.enqueueEvolutionEvidence().queued, 0, 'historical backfill collection must remain idempotent');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evolution_evidence_upload_queue WHERE source_id=?').get(message.id).count, 0,
    'Store-written messages with outbox records must bypass the legacy cursor queue');

  const insertForeignDeferred = db.prepare(`INSERT INTO evolution_evidence_outbox (
    outbox_id,local_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,content_hash,status,defer_reason,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,'deferred','unbound_remote_user',?,?)`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < 100; index += 1) {
      insertForeignDeferred.run(
        `foreign_deferred_${index}`,'other_local_user','other_instance','other_family','message',`other_message_${index}`,
        `other_hash_${index}`,'1999-01-01T00:00:00.000Z','1999-01-01T00:00:00.000Z',
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  await assert.rejects(() => sync.drainEvolutionEvidenceOutbox({ limit: 100 }), /temporary upload outage/);
  assert.ok(lastUploadedItems.length > 0, 'the active account must upload even when 100 older rows belong to another account');
  assert.ok(lastUploadedItems.every((item) => item.userAgentInstanceId !== 'other_instance'));
  assert.ok((store.evolutionEvidenceOutboxCounts().failed_retryable || 0) > 0);
  const retryRow = db.prepare("SELECT defer_reason,next_attempt_at FROM evolution_evidence_outbox WHERE local_user_id='outbox_local' AND status='failed_retryable' LIMIT 1").get();
  assert.equal(retryRow.defer_reason, 'cloud_upload_failed');
  assert.ok(Date.parse(retryRow.next_attempt_at) > Date.now(), 'retryable failures must receive a future retry time');
  const callsBeforeBackoffCheck = uploadCalls;
  assert.equal((await sync.drainEvolutionEvidenceOutbox({ limit: 100 })).status, 'empty');
  assert.equal(uploadCalls, callsBeforeBackoffCheck, 'backoff rows must not be reclaimed immediately');
  db.prepare("UPDATE evolution_evidence_outbox SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE local_user_id='outbox_local' AND status='failed_retryable'").run();
  const uploaded = await sync.drainEvolutionEvidenceOutbox({ limit: 500 });
  assert.ok(uploaded.uploaded > 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM evolution_evidence_outbox WHERE status='uploaded' AND remote_evidence_id<>''").get().count,
    uploaded.uploaded, 'reordered cloud receipts must map back to the exact client outbox record');
  const callsAfterUpload = uploadCalls;
  const empty = await sync.drainEvolutionEvidenceOutbox({ limit: 500 });
  assert.equal(empty.status, 'empty');
  assert.equal(uploadCalls, callsAfterUpload, 'uploaded outbox rows must never be sent again');
  const uploadStatus = store.evolutionEvidenceOutboxStatus({ localUserId: 'outbox_local' });
  assert.equal(uploadStatus.otherAccountsPending, 100);
  assert.equal(uploadStatus.currentAccount.failed_retryable || 0, 0);

  const inactiveMessage = store.addMessage({
    sessionId: session.id, role: 'assistant', content: 'retain while inactive', agentId: 'outbox_family', agentInstanceId: instance.id,
  });
  db.prepare("UPDATE user_agent_instances SET status='inactive',employment_state='inactive',deactivated_at=? WHERE id=?")
    .run(new Date(Date.now()+60000).toISOString(),instance.id);
  const inactiveUpload = await sync.drainEvolutionEvidenceOutbox({ limit: 500 });
  assert.ok(inactiveUpload.uploaded > 0);
  const inactivePayload=lastUploadedItems.find((item)=>item.sourceId===inactiveMessage.id);
  assert.ok(inactivePayload);
  assert.deepEqual(inactivePayload.allowedEvolutionScopes,[],'inactive Agent history uploads for audit but cannot create personal or cluster usage');

  console.log('evolution evidence outbox smoke passed');
} finally {
  try { sync?.close(); } catch {}
  try { db?.close(); } catch {}
  await rm(root, { recursive: true, force: true });
}

function outboxCount(database, sourceKind, sourceId) {
  return Number(database.prepare('SELECT COUNT(*) AS count FROM evolution_evidence_outbox WHERE source_kind=? AND source_id=?').get(sourceKind, sourceId).count || 0);
}

async function verifyHistoricalOutboxSchedulingUpgrade() {
  const legacyRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-evidence-outbox-upgrade-'));
  try {
    let legacyDb = openDatabase(legacyRoot);
    legacyDb.prepare(`INSERT INTO evolution_evidence_outbox (
      outbox_id,local_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,content_hash,status,last_error,created_at,updated_at
    ) VALUES ('upgrade_row','upgrade_user','upgrade_instance','upgrade_family','message','upgrade_message','upgrade_hash',
      'deferred','unbound_remote_user','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
    const preservedBefore = legacyDb.prepare(`SELECT outbox_id,local_user_id,user_agent_instance_id,agent_family_id,source_kind,
      source_id,content_hash,status,last_error,created_at,updated_at FROM evolution_evidence_outbox WHERE outbox_id='upgrade_row'`).get();
    legacyDb.exec(`DROP INDEX IF EXISTS idx_evolution_evidence_outbox_account_due;
      ALTER TABLE evolution_evidence_outbox DROP COLUMN next_attempt_at;
      ALTER TABLE evolution_evidence_outbox DROP COLUMN defer_reason;
      DELETE FROM schema_migrations WHERE id='evolution_evidence_outbox_scheduling_v4'`);
    legacyDb.close();

    legacyDb = openDatabase(legacyRoot);
    const columns = new Set(legacyDb.prepare('PRAGMA table_info(evolution_evidence_outbox)').all().map((row) => row.name));
    assert.ok(columns.has('next_attempt_at'));
    assert.ok(columns.has('defer_reason'));
    assert.deepEqual(legacyDb.prepare(`SELECT outbox_id,local_user_id,user_agent_instance_id,agent_family_id,source_kind,
      source_id,content_hash,status,last_error,created_at,updated_at FROM evolution_evidence_outbox WHERE outbox_id='upgrade_row'`).get(), preservedBefore);
    assert.equal(legacyDb.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='evolution_evidence_outbox_scheduling_v4'").get().count, 1);
    assert.equal(legacyDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(legacyDb.prepare('PRAGMA foreign_key_check').all(), []);
    legacyDb.close();

    legacyDb = openDatabase(legacyRoot);
    assert.deepEqual(legacyDb.prepare(`SELECT outbox_id,local_user_id,user_agent_instance_id,agent_family_id,source_kind,
      source_id,content_hash,status,last_error,created_at,updated_at FROM evolution_evidence_outbox WHERE outbox_id='upgrade_row'`).get(), preservedBefore);
    legacyDb.close();
  } finally {
    await rm(legacyRoot, { recursive: true, force: true });
  }
}
