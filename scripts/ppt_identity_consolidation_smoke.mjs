import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/main/db.js';
import { Store } from '../src/main/store.js';
import { classifyAgentFamily } from '../src/main/modules/identity/domain/employeePolicy.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-ppt-identity-smoke-'));
const db = openDatabase(root, { skipMigrationBackup: true });

try {
  assert.deepEqual(classifyAgentFamily({
    id: 'ppt',
    role: 'agent',
    status: 'active',
    enabled: false,
    routable: false,
    skillPackageId: 'ppt_creation',
    skillInstalled: false,
  }), {
    instanceKind: 'employee',
    recruitable: true,
    defaultForNewUser: false,
    quotaCost: 1,
    classificationVersion: 'employee_recruitment_phase_a_v1',
  });
  assert.equal(classifyAgentFamily({
    id: 'retired_plugin_agent',
    role: 'agent',
    status: 'retired',
    enabled: false,
    routable: false,
    skillPackageId: 'retired_plugin',
    skillInstalled: false,
  }).recruitable, false);

  for (const [userId, email] of [
    ['ppt_user_a', 'ppt-a@janus.test'],
    ['ppt_user_b', 'ppt-b@janus.test'],
    ['ppt_user_stale', 'ppt-stale@janus.test'],
  ]) {
    db.prepare(`INSERT INTO auth_users (id,email,display_name,auth_provider,email_verified)
      VALUES (?,?,'PPT migration user','local_mock',1)`).run(userId, email);
  }
  for (const [familyId, name] of [
    ['ppt', 'PPT'],
    ['ppt_research_scout', 'Legacy PPT Research Scout'],
  ]) {
    db.prepare(`INSERT INTO agent_families (id,department_id,name,role,status,routable)
      VALUES (?,'ppt_department',?,'agent','active',1)`).run(familyId, name);
  }
  for (const suffix of ['a', 'b']) {
    const userId = `ppt_user_${suffix}`;
    db.prepare(`INSERT INTO user_agent_instances (
      id,user_id,agent_family_id,status,instance_kind,employment_state,quota_exempt,authority_state
    ) VALUES (?,?,?,'active','employee','active',0,'migration_grandfathered')`).run(`ppt_canonical_${suffix}`, userId, 'ppt');
    db.prepare(`INSERT INTO user_agent_instances (
      id,user_id,agent_family_id,status,instance_kind,employment_state,quota_exempt,authority_state
    ) VALUES (?,?,?,'active','employee','active',0,'migration_grandfathered')`).run(`ppt_legacy_${suffix}`, userId, 'ppt_research_scout');
    db.prepare(`INSERT INTO sessions (
      id,user_id,title,department_id,agent_id,agent_instance_id,status
    ) VALUES (?,?,'Legacy PPT chat','ppt_department','ppt_research_scout',?,'active')`).run(
      `ppt_session_${suffix}`,
      userId,
      `ppt_legacy_${suffix}`,
    );
  }
  db.prepare(`INSERT INTO user_agent_instances (
    id,user_id,agent_family_id,status,instance_kind,employment_state,quota_exempt,authority_state,
    policy_version,recruited_at,last_state_changed_at
  ) VALUES ('ppt_stale_instance','ppt_user_stale','ppt','active','unavailable','active',1,'migration_grandfathered',
    'employee_recruitment_phase_a_v1','2026-07-23T05:17:13.077Z','2026-07-23T05:17:13.077Z')`).run();

  const store = new Store(db, { root });
  assert.doesNotThrow(() => store.reconcileAgentIdentityCatalog({
    organization: {
      agents: [{
        id: 'ppt',
        name: 'PPT',
        departmentId: 'ppt_department',
        role: 'agent',
        lifecycleStatus: 'active',
        enabled: false,
        routable: false,
        skillPackageId: 'ppt_creation',
        skillInstalled: false,
        baseSkill: 'Create presentations.',
      }],
    },
  }));

  db.prepare(`INSERT INTO auth_users (id,email,display_name,auth_provider,email_verified)
    VALUES ('ppt_user_market','ppt-market@janus.test','PPT market user','local_mock',1)`).run();
  const marketCandidate = store.listRecruitableAgentFamilies({ userId: 'ppt_user_market' })
    .find((family) => family.id === 'ppt');
  assert.equal(marketCandidate?.canRecruit, true, 'an installable Agent must remain visible and recruitable before its Skill is installed');
  assert.equal(store.getAgentFamily('ppt').routable, false, 'an uninstalled Skill must still prevent task routing');
  const repairedStaleInstance = store.findUserAgentInstance({ userId: 'ppt_user_stale', agentFamilyId: 'ppt' });
  assert.equal(repairedStaleInstance.instanceKind, 'employee', 'catalog reconciliation must repair recruited employees left with a legacy unavailable classification');
  assert.equal(repairedStaleInstance.quotaExempt, false, 'a repaired employee must return to normal quota accounting');
  assert.equal(store.listEmployeeRoster({ userId: 'ppt_user_stale' })[0]?.routeEligible, false, 'an uninstalled Skill must remain non-routable after classification repair');

  store.reconcileAgentIdentityCatalog({
    organization: {
      agents: [{
        id: 'ppt', name: 'PPT', departmentId: 'ppt_department', role: 'agent', lifecycleStatus: 'active',
        enabled: true, routable: true, skillPackageId: 'ppt_creation', skillInstalled: true, baseSkill: 'Create presentations.',
      }],
    },
  });
  assert.equal(store.listEmployeeRoster({ userId: 'ppt_user_stale' })[0]?.routeEligible, true, 'installing the Skill and refreshing the catalog must make an already recruited employee routable');

  for (const suffix of ['a', 'b']) {
    assert.deepEqual(
      { ...db.prepare('SELECT agent_id,agent_instance_id FROM sessions WHERE id=?').get(`ppt_session_${suffix}`) },
      { agent_id: 'ppt', agent_instance_id: `ppt_canonical_${suffix}` },
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_agent_instances WHERE id=?').get(`ppt_legacy_${suffix}`).count, 0);
    assert.deepEqual(
      { ...db.prepare('SELECT canonical_instance_id,user_id FROM user_agent_instance_aliases WHERE alias_instance_id=?').get(`ppt_legacy_${suffix}`) },
      { canonical_instance_id: `ppt_canonical_${suffix}`, user_id: `ppt_user_${suffix}` },
    );
  }
  const canonicalA = store.findUserAgentInstance({ userId: 'ppt_user_a', agentFamilyId: 'ppt' });
  const pendingDeactivate = store.stagePendingEmployeeCommand({
    userId: 'ppt_user_a', remoteUserId: 'remote_ppt_user_a', action: 'deactivate',
    agentFamilyId: 'ppt_research_scout', agentInstanceId: 'ppt_legacy_a',
    commandId: 'ppt-canonical:disable', expectedStateRevision: canonicalA.stateRevision,
  });
  const pendingReactivate = store.stagePendingEmployeeCommand({
    userId: 'ppt_user_a', remoteUserId: 'remote_ppt_user_a', action: 'reactivate',
    agentFamilyId: 'ppt_research_scout', agentInstanceId: 'ppt_legacy_a',
    commandId: 'ppt-canonical:reactivate', expectedStateRevision: pendingDeactivate.instance.stateRevision,
  });
  assert.equal(pendingDeactivate.command.agentFamilyId, 'ppt');
  assert.equal(pendingReactivate.command.agentFamilyId, 'ppt');
  assert.equal(pendingReactivate.instance.id, canonicalA.id);
  assert.equal(pendingReactivate.command.dependsOnCommandId, pendingDeactivate.command.commandId);
  const invalidSessions = db.prepare(`SELECT COUNT(*) AS count FROM sessions s
    LEFT JOIN user_agent_instances i ON i.id=s.agent_instance_id
    WHERE s.agent_instance_id!='' AND (
      i.id IS NULL OR i.user_id!=s.user_id OR (s.agent_id!='' AND i.agent_family_id!=s.agent_id)
    )`).get().count;
  assert.equal(invalidSessions, 0);
  process.stdout.write(`${JSON.stringify({ status: 'passed', users: 3, invalidSessions })}\n`);
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
