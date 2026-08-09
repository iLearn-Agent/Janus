import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { newDb } from 'pg-mem';

import { migrate } from '../src/db.mjs';
import { createPostgresWorkMemoryService } from '../src/modules/work-memory/index.mjs';
import { encryptTaskMemoryContent, wrapTaskKeyForCloud } from '../../src/shared/taskMemoryCrypto.js';

test('PostgreSQL Work Memory authorizes exact federated work and decrypts only after approval', async (t) => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  t.after(() => pool.end());
  await pool.query('CREATE TABLE schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  await pool.query("INSERT INTO schema_migrations(filename) VALUES('011_employee_authority.sql')");
  await migrate(pool);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyId = 'work-memory-test-key';
  const env = {
    JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID: keyId,
    JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON: JSON.stringify({ [keyId]: privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
  };
  const publicKeyring = { activeKeyId: keyId, keys: { [keyId]: publicKey.export({ type: 'spki', format: 'pem' }) } };
  const service = createPostgresWorkMemoryService({ pool, env });

  for (const userId of ['requester', 'recipient', 'outsider', 'group_member']) {
    await pool.query('INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,\'hash\')', [userId, `${userId}@example.test`, userId]);
  }
  await pool.query("INSERT INTO cloud_agent_families_v3(id,department_id,name,payload_json) VALUES('family','general','Family','{}'::jsonb)");
  await pool.query("INSERT INTO cloud_agent_versions_v3(id,agent_family_id,payload_json) VALUES('base','family','{}'::jsonb)");
  for (const [userId, instanceId] of [['requester', 'requester_agent'], ['recipient', 'recipient_agent'], ['outsider', 'outsider_agent'], ['group_member', 'group_member_agent']]) {
    await pool.query(`INSERT INTO cloud_user_agent_instances_v3 (
      user_id,id,agent_family_id,base_agent_version_id,status,sync_enabled
    ) VALUES ($1,$2,'family','base','active',true)`, [userId, instanceId]);
  }
  await pool.query(`INSERT INTO agent_delegations (
    id,requester_user_id,recipient_user_id,title,instruction,status
  ) VALUES ('delegation_1','requester','recipient','Task','Do it','working')`);
  await pool.query(`INSERT INTO agent_delegations (
    id,requester_user_id,recipient_user_id,title,instruction,status
  ) VALUES ('delegation_2','outsider','recipient','Other','Other work','working')`);

  const collaborators = publication({
    content: 'Recipient progress for direct collaborator.',
    visibility: 'work_collaborators',
    versionId: 'version_collaborators',
    publicKeyring,
  });
  await service.publish({
    userId: 'recipient',
    payload: {
      federationType: 'delegation', federationId: 'delegation_1',
      participant: { role: 'executor' }, version: collaborators,
    },
  });
  const allowed = await service.read({
    userId: 'requester',
    payload: {
      federationType: 'delegation', federationId: 'delegation_1',
      requesterAgentInstanceId: 'requester_agent', targetAgentInstanceId: 'recipient_agent',
      memoryDocumentVersionId: 'version_collaborators',
    },
  });
  assert.equal(allowed.content, 'Recipient progress for direct collaborator.');

  await assert.rejects(service.read({
    userId: 'outsider',
    payload: {
      federationType: 'delegation', federationId: 'delegation_1',
      requesterAgentInstanceId: 'outsider_agent', targetAgentInstanceId: 'recipient_agent',
      memoryDocumentVersionId: 'version_collaborators',
    },
  }), (error) => error.code === 'work_scope_not_found');
  await assert.rejects(service.read({
    userId: 'requester',
    payload: {
      federationType: 'delegation', federationId: 'delegation_2',
      requesterAgentInstanceId: 'requester_agent', targetAgentInstanceId: 'recipient_agent',
      memoryDocumentVersionId: 'version_collaborators',
    },
  }), (error) => error.code === 'work_scope_not_found');

  const leadership = publication({
    content: 'Leadership-only escalation.', visibility: 'work_leadership',
    versionId: 'version_leadership', publicKeyring,
  });
  await service.publish({
    userId: 'recipient',
    payload: { federationType: 'delegation', federationId: 'delegation_1', version: leadership },
  });
  await assert.rejects(service.read({
    userId: 'requester',
    payload: {
      federationType: 'delegation', federationId: 'delegation_1',
      requesterAgentInstanceId: 'requester_agent', targetAgentInstanceId: 'recipient_agent',
      memoryDocumentVersionId: 'version_leadership',
    },
  }), (error) => error.code === 'leadership_appointment_required');
  await service.appoint({
    userId: 'requester',
    payload: {
      federationType: 'delegation', federationId: 'delegation_1',
      targetUserId: 'requester', targetAgentInstanceId: 'requester_agent', role: 'task_lead',
    },
  });
  const leadershipAfterAppointment = publication({
    content: 'Leadership detail after appointment.', visibility: 'work_leadership',
    versionId: 'version_leadership_after_appointment', publicKeyring,
  });
  await service.publish({
    userId: 'recipient',
    payload: { federationType: 'delegation', federationId: 'delegation_1', version: leadershipAfterAppointment },
  });
  assert.equal((await service.read({
    userId: 'requester',
    payload: {
      federationType: 'delegation', federationId: 'delegation_1',
      requesterAgentInstanceId: 'requester_agent', targetAgentInstanceId: 'recipient_agent',
      memoryDocumentVersionId: 'version_leadership_after_appointment',
    },
  })).content, 'Leadership detail after appointment.');
  await assert.rejects(service.revoke({
    userId: 'recipient',
    payload: {
      federationType: 'delegation', federationId: 'delegation_1',
      targetUserId: 'requester', targetAgentInstanceId: 'requester_agent',
    },
  }), (error) => error.code === 'work_leadership_revocation_forbidden');
  const revocation = await service.revoke({
    userId: 'requester',
    payload: {
      federationType: 'delegation', federationId: 'delegation_1',
      targetUserId: 'requester', targetAgentInstanceId: 'requester_agent',
    },
  });
  assert.equal(revocation.revokedCount, 1);
  const leadershipAfterRevocation = publication({
    content: 'Leadership detail after revocation.', visibility: 'work_leadership',
    versionId: 'version_leadership_after_revocation', publicKeyring,
  });
  await service.publish({
    userId: 'recipient',
    payload: { federationType: 'delegation', federationId: 'delegation_1', version: leadershipAfterRevocation },
  });
  await assert.rejects(service.read({
    userId: 'requester',
    payload: {
      federationType: 'delegation', federationId: 'delegation_1',
      requesterAgentInstanceId: 'requester_agent', targetAgentInstanceId: 'recipient_agent',
      memoryDocumentVersionId: 'version_leadership_after_revocation',
    },
  }), (error) => error.code === 'leadership_appointment_required');

  await pool.query("INSERT INTO collaboration_groups(id,owner_user_id,title,status) VALUES('group_1','requester','Group','active')");
  for (const userId of ['requester', 'recipient']) {
    await pool.query(`INSERT INTO collaboration_group_members(group_id,user_id,role,status,joined_at)
      VALUES ('group_1',$1,'member','active','2000-01-01T00:00:00.000Z')`, [userId]);
  }
  await pool.query(`INSERT INTO collaboration_group_members(group_id,user_id,role,status,joined_at,left_at)
    VALUES ('group_1','group_member','member','removed','2000-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')`);
  const groupBeforeRemoval = publication({
    content: 'Group progress before removal.', visibility: 'work_participants',
    versionId: 'group_before_removal', publishedAt: '2010-01-01T00:00:00.000Z', publicKeyring,
  });
  await service.publish({
    userId: 'recipient',
    payload: { federationType: 'collaboration_group', federationId: 'group_1', version: groupBeforeRemoval },
  });
  assert.equal((await service.read({
    userId: 'group_member',
    payload: {
      federationType: 'collaboration_group', federationId: 'group_1',
      requesterAgentInstanceId: 'group_member_agent', targetAgentInstanceId: 'recipient_agent',
      memoryDocumentVersionId: 'group_before_removal',
    },
  })).content, 'Group progress before removal.');
  const groupAfterRemoval = publication({
    content: 'Group progress after removal.', visibility: 'work_participants',
    versionId: 'group_after_removal', publishedAt: '2021-01-01T00:00:00.000Z', publicKeyring,
  });
  await service.publish({
    userId: 'recipient',
    payload: { federationType: 'collaboration_group', federationId: 'group_1', version: groupAfterRemoval },
  });
  await assert.rejects(service.read({
    userId: 'group_member',
    payload: {
      federationType: 'collaboration_group', federationId: 'group_1',
      requesterAgentInstanceId: 'group_member_agent', targetAgentInstanceId: 'recipient_agent',
      memoryDocumentVersionId: 'group_after_removal',
    },
  }), (error) => error.code === 'requester_outside_membership_window');

  await assert.rejects(service.publish({
    userId: 'recipient',
    payload: {
      federationType: 'delegation', federationId: 'delegation_1',
      version: { ...collaborators, memoryDocumentVersionId: 'private_version', visibility: 'agent_private' },
    },
  }), (error) => error.code === 'invalid_work_visibility');
  const audits = await pool.query('SELECT result,result_code FROM cloud_work_memory_access_audits ORDER BY created_at');
  assert.deepEqual(audits.rows.map((row) => row.result), ['allowed', 'denied', 'denied', 'denied', 'allowed', 'denied', 'allowed', 'denied']);
});

function publication({ content, visibility, versionId, publicKeyring, publishedAt = new Date().toISOString() }) {
  const dataKey = crypto.randomBytes(32);
  const encrypted = encryptTaskMemoryContent(content, dataKey, { documentId: 'document_1', versionNo: 2, keyVersion: 1 });
  const envelope = wrapTaskKeyForCloud(dataKey, publicKeyring);
  return {
    id: `cloud_${versionId}`,
    agentInstanceId: 'recipient_agent',
    memoryDocumentId: 'document_1',
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
