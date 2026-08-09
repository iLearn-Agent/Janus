import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { openCloudDatabase } from '../../src/cloud/server.js';
import { createCloudWorkMemoryService } from '../../src/cloud/modules/collaboration/application/cloudWorkMemory.js';
import { encryptTaskMemoryContent, wrapTaskKeyForCloud } from '../../src/shared/taskMemoryCrypto.js';

test('SQLite cloud Work Memory enforces federation, membership windows, leadership windows, encryption, and audits', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-sqlite-work-memory-'));
  const db = openCloudDatabase(home);
  t.after(async () => {
    db.close();
    await fs.rm(home, { recursive: true, force: true });
  });

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyId = 'sqlite-work-memory-key';
  const env = {
    JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID: keyId,
    JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON: JSON.stringify({
      [keyId]: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }),
  };
  const publicKeyring = {
    activeKeyId: keyId,
    keys: { [keyId]: publicKey.export({ type: 'spki', format: 'pem' }) },
  };
  const service = createCloudWorkMemoryService({ db, env });
  const base = Date.now() - 60 * 60 * 1000;
  const at = (minutes) => new Date(base + minutes * 60 * 1000).toISOString();

  for (const userId of ['requester', 'recipient', 'outsider', 'group_member']) {
    db.prepare(`INSERT INTO users(id,email,display_name,username,password_hash,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(userId, `${userId}@example.test`, userId, userId, 'hash', at(0), at(0));
    db.prepare(`INSERT INTO cloud_user_agent_instances_v3 (
      user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled,created_at,updated_at
    ) VALUES (?,?,?,'base','active',1,?,?)`).run(userId, `${userId}_agent`, `${userId}_family`, at(0), at(0));
  }
  db.prepare(`INSERT INTO agent_delegations (
    id,requester_user_id,recipient_user_id,title,instruction,status,created_at,updated_at
  ) VALUES ('delegation_1','requester','recipient','Task','Do it','working',?,?)`).run(at(0), at(0));
  db.prepare(`INSERT INTO agent_delegations (
    id,requester_user_id,recipient_user_id,title,instruction,status,created_at,updated_at
  ) VALUES ('delegation_2','outsider','recipient','Other','Other work','working',?,?)`).run(at(0), at(0));

  await publish(service, {
    userId: 'recipient', federationType: 'delegation', federationId: 'delegation_1',
    version: publication({
      content: 'Recipient progress.', visibility: 'work_collaborators', versionId: 'delegation_progress',
      agentInstanceId: 'recipient_agent', publishedAt: at(10), publicKeyring,
    }),
  });
  assert.equal(service.read({
    userId: 'requester',
    payload: readPayload('delegation', 'delegation_1', 'requester_agent', 'recipient_agent', 'delegation_progress'),
  }).content, 'Recipient progress.');
  assert.throws(() => service.read({
    userId: 'outsider',
    payload: readPayload('delegation', 'delegation_1', 'outsider_agent', 'recipient_agent', 'delegation_progress'),
  }), (error) => error.code === 'work_scope_not_found');
  assert.throws(() => service.read({
    userId: 'requester',
    payload: readPayload('delegation', 'delegation_2', 'requester_agent', 'recipient_agent', 'delegation_progress'),
  }), (error) => error.code === 'work_scope_not_found');

  assert.throws(() => service.publish({
    userId: 'recipient',
    payload: {
      federationType: 'delegation', federationId: 'delegation_1',
      version: { ...publication({
        content: 'Private.', visibility: 'work_collaborators', versionId: 'private',
        agentInstanceId: 'recipient_agent', publishedAt: at(15), publicKeyring,
      }), visibility: 'agent_private' },
    },
  }), (error) => error.code === 'invalid_work_visibility');

  await publish(service, {
    userId: 'recipient', federationType: 'delegation', federationId: 'delegation_1',
    version: publication({
      content: 'Leadership before appointment.', visibility: 'work_leadership', versionId: 'leadership_before',
      agentInstanceId: 'recipient_agent', publishedAt: at(20), publicKeyring,
    }),
  });
  assert.throws(() => service.read({
    userId: 'requester',
    payload: readPayload('delegation', 'delegation_1', 'requester_agent', 'recipient_agent', 'leadership_before'),
  }), (error) => error.code === 'leadership_appointment_required');
  service.appoint({
    userId: 'requester',
    payload: {
      federationType: 'delegation', federationId: 'delegation_1',
      targetUserId: 'requester', targetAgentInstanceId: 'requester_agent', role: 'task_lead',
      validFrom: at(30),
    },
  });
  await publish(service, {
    userId: 'recipient', federationType: 'delegation', federationId: 'delegation_1',
    version: publication({
      content: 'Leadership during appointment.', visibility: 'work_leadership', versionId: 'leadership_during',
      agentInstanceId: 'recipient_agent', publishedAt: at(40), publicKeyring,
    }),
  });
  assert.equal(service.read({
    userId: 'requester',
    payload: readPayload('delegation', 'delegation_1', 'requester_agent', 'recipient_agent', 'leadership_during'),
  }).content, 'Leadership during appointment.');
  assert.throws(() => service.revoke({
    userId: 'recipient',
    payload: {
      federationType: 'delegation', federationId: 'delegation_1',
      targetUserId: 'requester', targetAgentInstanceId: 'requester_agent', revokedAt: at(45),
    },
  }), (error) => error.code === 'work_leadership_revocation_forbidden');
  assert.equal(service.revoke({
    userId: 'requester',
    payload: {
      federationType: 'delegation', federationId: 'delegation_1',
      targetUserId: 'requester', targetAgentInstanceId: 'requester_agent', revokedAt: at(45),
    },
  }).revokedCount, 1);
  await publish(service, {
    userId: 'recipient', federationType: 'delegation', federationId: 'delegation_1',
    version: publication({
      content: 'Leadership after revocation.', visibility: 'work_leadership', versionId: 'leadership_after',
      agentInstanceId: 'recipient_agent', publishedAt: at(50), publicKeyring,
    }),
  });
  assert.throws(() => service.read({
    userId: 'requester',
    payload: readPayload('delegation', 'delegation_1', 'requester_agent', 'recipient_agent', 'leadership_after'),
  }), (error) => error.code === 'leadership_appointment_required');

  db.prepare(`INSERT INTO collaboration_groups(id,owner_user_id,title,status,created_at,updated_at)
    VALUES ('group_1','requester','Group','active',?,?)`).run(at(0), at(0));
  for (const userId of ['requester', 'recipient']) {
    db.prepare(`INSERT INTO collaboration_group_members(group_id,user_id,role,status,joined_at)
      VALUES ('group_1',?,'member','active',?)`).run(userId, at(0));
  }
  db.prepare(`INSERT INTO collaboration_group_members(group_id,user_id,role,status,joined_at,left_at)
    VALUES ('group_1','group_member','member','removed',?,?)`).run(at(0), at(35));
  await publish(service, {
    userId: 'recipient', federationType: 'collaboration_group', federationId: 'group_1',
    participant: { role: 'executor', collaborationAgentInstanceIds: ['group_member_agent'] },
    version: publication({
      content: 'Group progress before removal.', visibility: 'work_participants', versionId: 'group_before',
      agentInstanceId: 'recipient_agent', publishedAt: at(30), publicKeyring,
    }),
  });
  assert.equal(service.read({
    userId: 'group_member',
    payload: readPayload('collaboration_group', 'group_1', 'group_member_agent', 'recipient_agent', 'group_before'),
  }).content, 'Group progress before removal.');
  await publish(service, {
    userId: 'recipient', federationType: 'collaboration_group', federationId: 'group_1',
    version: publication({
      content: 'Group progress after removal.', visibility: 'work_participants', versionId: 'group_after',
      agentInstanceId: 'recipient_agent', publishedAt: at(40), publicKeyring,
    }),
  });
  assert.throws(() => service.read({
    userId: 'group_member',
    payload: readPayload('collaboration_group', 'group_1', 'group_member_agent', 'recipient_agent', 'group_after'),
  }), (error) => error.code === 'requester_outside_membership_window');

  const audits = db.prepare('SELECT result,result_code FROM cloud_work_memory_access_audits ORDER BY rowid').all();
  assert.equal(audits.length, 8);
  assert.deepEqual(audits.map((row) => row.result), ['allowed', 'denied', 'denied', 'denied', 'allowed', 'denied', 'allowed', 'denied']);
  const columns = db.prepare('PRAGMA table_info(cloud_work_memory_versions)').all().map((row) => row.name);
  assert.equal(columns.includes('content'), false);
  const stored = db.prepare("SELECT content_ciphertext FROM cloud_work_memory_versions WHERE memory_document_version_id='delegation_progress'").get();
  assert.notEqual(stored.content_ciphertext, 'Recipient progress.');
});

function publish(service, { userId, federationType, federationId, participant = {}, version }) {
  return service.publish({ userId, payload: { federationType, federationId, participant, version } });
}

function readPayload(federationType, federationId, requesterAgentInstanceId, targetAgentInstanceId, memoryDocumentVersionId) {
  return { federationType, federationId, requesterAgentInstanceId, targetAgentInstanceId, memoryDocumentVersionId };
}

function publication({ content, visibility, versionId, agentInstanceId, publishedAt, publicKeyring }) {
  const dataKey = crypto.randomBytes(32);
  const documentId = `document_${agentInstanceId}`;
  const encrypted = encryptTaskMemoryContent(content, dataKey, { documentId, versionNo: 2, keyVersion: 1 });
  const envelope = wrapTaskKeyForCloud(dataKey, publicKeyring);
  return {
    id: `cloud_${versionId}`,
    agentInstanceId,
    memoryDocumentId: documentId,
    memoryDocumentVersionId: versionId,
    versionNo: 2,
    visibility,
    contentHash: crypto.createHash('sha256').update(content).digest('hex'),
    encryptionAlgorithm: encrypted.algorithm,
    encryptionKeyVersion: 1,
    contentCiphertext: encrypted.ciphertext,
    contentNonce: encrypted.nonce,
    contentTag: encrypted.tag,
    contentAad: encrypted.aad,
    cloudWrapAlgorithm: envelope.algorithm,
    cloudWrappingKeyId: envelope.keyId,
    cloudWrappedKey: envelope.wrappedKey,
    publishedAt,
  };
}
