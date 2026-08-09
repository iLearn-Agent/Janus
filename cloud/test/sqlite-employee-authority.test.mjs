import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createCloudEmployeeAuthority } from '../../src/cloud/modules/identity/index.js';
import { openCloudDatabase } from '../../src/cloud/server.js';

test('SQLite employee authority enforces quota, revision conflicts, idempotency, and canonical IDs', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-sqlite-employees-'));
  const db = openCloudDatabase(home);
  t.after(async () => {
    db.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  db.prepare(`INSERT INTO users (id,email,display_name,username,password_hash)
    VALUES ('user','employee@example.com','Employee User','employee_user','hash')`).run();
  db.prepare(`INSERT INTO users (id,email,display_name,username,password_hash)
    VALUES ('bootstrap_user','bootstrap@example.com','Bootstrap User','bootstrap_user','hash')`).run();
  const now = new Date().toISOString();
  for (let index = 1; index <= 11; index += 1) {
    db.prepare(`INSERT INTO cloud_agent_families_v3 (
      id,department_id,name,role,status,routable,instance_kind,recruitable,quota_cost,current_version_id,payload_json,updated_at
    ) VALUES (?,?,?,'agent','active',1,'employee',1,1,?,'{}',?)`).run(
      `family_${index}`, 'department', `Family ${index}`, `version_${index}`, now,
    );
  }
  db.prepare(`INSERT INTO cloud_agent_families_v3 (
    id,department_id,name,role,status,routable,instance_kind,recruitable,quota_cost,payload_json,updated_at
  ) VALUES ('secretary_agent','secretary_department','uBuddy','agent','active',1,'system',0,0,'{}',?)`).run(now);
  db.prepare("UPDATE cloud_agent_families_v3 SET default_for_new_user=1 WHERE id='family_1'").run();

  const authority = createCloudEmployeeAuthority({ db });
  assert.equal(authority.capabilities().lifecycleMutation, 'command_only');
  assert.equal(authority.capabilities().instanceAliasProjection, 'overview_v1');
  assert.equal(authority.capabilities().localInstanceAdoption, 'recruit_preserve_state_v1');
  const bootstrapped = authority.bootstrap({ userId: 'bootstrap_user', deviceId: 'device_bootstrap', payload: { bootstrapId: 'bootstrap_v1', instances: [] } });
  assert.equal(bootstrapped.roster.length, 1);
  assert.equal(bootstrapped.systemRoster.length, 1);
  assert.equal(bootstrapped.rosterRevision, 1);
  assert.equal(authority.bootstrap({ userId: 'bootstrap_user', deviceId: 'other', payload: { bootstrapId: 'bootstrap_v1' } }).idempotent, true);
  db.prepare("INSERT INTO cloud_employee_roster_states(user_id,bootstrap_status,bootstrap_id) VALUES('user','completed','test_setup')").run();
  const first = authority.command({
    userId: 'user', deviceId: 'device_a',
    payload: { action: 'recruit', commandId: 'recruit_1', agentFamilyId: 'family_1', proposedInstanceId: 'proposed_1', familyInstanceSeq: 99, displayName: 'Family 1 Z' },
  });
  assert.equal(first.status, 'confirmed');
  assert.equal(first.instance.id, 'proposed_1');
  assert.equal(first.instance.personalEvolutionConsent, true);
  assert.equal(first.instance.clusterContributionConsent,true);
  assert.equal(first.instance.personalSkillAutoActivate, false);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM cloud_memory_documents_v3
    WHERE user_id='user' AND user_agent_instance_id='proposed_1' AND scope='general' AND slot_no=0`).get().count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM cloud_agent_context_states
    WHERE owner_user_id='user' AND user_agent_instance_id='proposed_1' AND active_memory_document_id<>''`).get().count, 1);
  const replay = authority.command({
    userId: 'user', deviceId: 'device_b',
    payload: { action: 'recruit', commandId: 'recruit_1', agentFamilyId: 'family_1', proposedInstanceId: 'different' },
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.instance.id, 'proposed_1');

  const sameFamily = authority.command({
    userId: 'user', deviceId: 'device_same_family',
    payload: { action: 'recruit', commandId: 'recruit_1_b', agentFamilyId: 'family_1', proposedInstanceId: 'proposed_1_b', familyInstanceSeq: 99, displayName: 'Research Lead' },
  });
  assert.equal(sameFamily.status, 'confirmed');
  assert.notEqual(sameFamily.instance.id, first.instance.id);
  assert.equal(first.instance.displayName, 'Family 1 A');
  assert.equal(first.instance.familyInstanceSeq, 1);
  assert.equal(sameFamily.instance.familyInstanceSeq, 2);
  assert.equal(sameFamily.instance.displayName, 'Research Lead');
  assert.notEqual(
    db.prepare("SELECT id FROM cloud_memory_documents_v3 WHERE user_id='user' AND user_agent_instance_id='proposed_1'").get().id,
    db.prepare("SELECT id FROM cloud_memory_documents_v3 WHERE user_id='user' AND user_agent_instance_id='proposed_1_b'").get().id,
  );
  const familyOneCatalog = authority.overview({ userId: 'user' }).recruitableFamilies.find((item) => item.id === 'family_1');
  assert.equal(familyOneCatalog.instanceCount, 2);
  assert.equal(familyOneCatalog.activeInstanceCount, 2);

  for (let index = 2; index <= 9; index += 1) {
    const result = authority.command({
      userId: 'user', deviceId: `device_${index}`,
      payload: { action: 'recruit', commandId: `recruit_${index}`, agentFamilyId: `family_${index}` },
    });
    assert.equal(result.status, 'confirmed');
  }
  const overLimit = authority.command({
    userId: 'user', deviceId: 'device_over',
    payload: { action: 'recruit', commandId: 'recruit_10', agentFamilyId: 'family_10' },
  });
  assert.equal(overLimit.status, 'rejected');
  assert.equal(overLimit.code, 'employee_quota_exceeded');
  assert.equal(authority.overview({ userId: 'user' }).quota.used, 10);
  assert.equal(authority.overview({ userId: 'user' }).roster.some((item) => item.agentFamilyId === 'secretary_agent'), false);
  const adoptedInactive = authority.command({
    userId: 'user', deviceId: 'device_adoption',
    payload: {
      action: 'recruit', commandId: 'adopt_inactive', agentFamilyId: 'family_10',
      proposedInstanceId: 'local_inactive', adoptLocalInstance: true, employmentState: 'inactive',
    },
  });
  assert.equal(adoptedInactive.status, 'confirmed');
  assert.equal(adoptedInactive.instance.employmentState, 'inactive');
  assert.equal(adoptedInactive.instance.recruitmentSource, 'local_instance_adoption');
  assert.equal(authority.overview({ userId: 'user' }).quota.used, 10);
  db.prepare(`INSERT INTO cloud_user_agent_instance_aliases_v3(user_id,alias_instance_id,canonical_instance_id,reason)
    VALUES('user','legacy_proposed_1','proposed_1','test_alias')`).run();
  assert.deepEqual(authority.overview({ userId: 'user' }).aliases.map((item) => ({
    aliasInstanceId: item.aliasInstanceId,
    canonicalInstanceId: item.canonicalInstanceId,
    reason: item.reason,
  })), [{ aliasInstanceId: 'legacy_proposed_1', canonicalInstanceId: 'proposed_1', reason: 'test_alias' }]);

  const staleDeactivate = authority.command({
    userId: 'user', deviceId: 'device_a',
    payload: { action: 'deactivate', commandId: 'deactivate_stale', agentInstanceId: 'proposed_1', expectedStateRevision: 99 },
  });
  assert.equal(staleDeactivate.status, 'rejected');
  assert.equal(staleDeactivate.code, 'employee_state_conflict');
  const deactivated = authority.command({
    userId: 'user', deviceId: 'device_a',
    payload: { action: 'deactivate', commandId: 'deactivate_ok', agentInstanceId: 'proposed_1', expectedStateRevision: 1 },
  });
  assert.equal(deactivated.status, 'confirmed');
  assert.equal(deactivated.instance.employmentState, 'inactive');
  assert.equal(deactivated.quota.used, 9);
  assert.equal(authority.events({ userId: 'user' }).length, 14);
});
