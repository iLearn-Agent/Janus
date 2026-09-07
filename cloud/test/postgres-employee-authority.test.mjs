import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';

import { newDb } from 'pg-mem';

import { createPostgresEmployeeAuthority } from '../src/modules/employees/index.mjs';

test('PostgreSQL employee authority serializes commands per user and preserves idempotency', async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pg = memory.adapters.createPg();
  const pool = new pg.Pool();
  try {
    await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
    await pool.query(await fs.readFile(new URL('../migrations/008_evolution_authority.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/010_cluster_market_evolution.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/011_employee_authority.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/013_multi_memory_task_security.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/017_cloud_sync_v6.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/020_primary_context_memory.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/023_employee_cloud_authority_cutover.sql', import.meta.url), 'utf8'));
    await pool.query(await pgMemMigration('../migrations/040_stage123_authority_closure.sql'));
    await pool.query(await pgMemMigration('../migrations/078_employee_instance_profile_uniqueness.sql'));
    await pool.query(`ALTER TABLE cloud_memory_documents_v3
      ADD CONSTRAINT chk_employee_test_memory_visibility
      CHECK(visibility IN ('agent_private','owner_private','work_collaborators','work_leadership','work_participants','work_summary'))`);
    await pool.query("INSERT INTO users(id) VALUES('user'),('bootstrap_user')");
    await pool.query(`INSERT INTO cloud_agent_families_v3 (
      id,department_id,name,role,status,routable,current_version_id,instance_kind,recruitable,quota_cost
    ) VALUES ('family','department','Family','agent','active',true,'base','employee',true,1)`);
    await pool.query("UPDATE cloud_agent_families_v3 SET default_for_new_user=true WHERE id='family'");
    await pool.query(`INSERT INTO cloud_agent_families_v3(
      id,department_id,name,role,status,routable,current_version_id,instance_kind,recruitable,quota_cost
    ) VALUES('secretary_agent','secretary','uBuddy','agent','active',true,'base','system',false,0)`);
    const authority = createPostgresEmployeeAuthority({ pool, apiError });
    assert.equal(authority.capabilities().lifecycleMutation, 'command_only');
    assert.equal(authority.capabilities().instanceAliasProjection, 'overview_v1');
    assert.equal(authority.capabilities().localInstanceAdoption, 'recruit_preserve_state_v1');
    const bootstrapped = await authority.bootstrap({
      userId: 'bootstrap_user', deviceId: 'device_bootstrap',
      payload: { bootstrapId: 'bootstrap_v1', instances: [] },
    });
    assert.equal(bootstrapped.status, 'completed');
    assert.equal(bootstrapped.roster.length, 1);
    assert.equal(bootstrapped.systemRoster.length, 1);
    assert.equal(bootstrapped.rosterRevision, 1);
    assert.equal((await authority.bootstrap({ userId: 'bootstrap_user', deviceId: 'other', payload: { bootstrapId: 'bootstrap_v1' } })).idempotent, true);
    await pool.query("INSERT INTO cloud_employee_roster_states(user_id,bootstrap_status,bootstrap_id) VALUES('user','completed','test_setup')");
    const first = await authority.command({
      userId: 'user', deviceId: 'device_a',
      payload: { action: 'recruit', commandId: 'command_1', agentFamilyId: 'family', proposedInstanceId: 'proposed', familyInstanceSeq: 99, displayName: 'Family Z' },
    });
    assert.equal(first.status, 'confirmed');
    assert.equal(first.instance.id, 'proposed');
    assert.equal(first.instance.familyInstanceSeq, 1);
    assert.equal(first.instance.displayName, 'Family A');
    assert.equal(Number((await pool.query(`SELECT COUNT(*) AS count FROM cloud_memory_documents_v3
      WHERE user_id='user' AND user_agent_instance_id='proposed' AND scope='general' AND slot_no=0`)).rows[0].count), 1);
    assert.equal((await pool.query(`SELECT visibility FROM cloud_memory_documents_v3
      WHERE user_id='user' AND user_agent_instance_id='proposed' AND scope='general' AND slot_no=0`)).rows[0].visibility, 'agent_private');
    assert.equal(Number((await pool.query(`SELECT COUNT(*) AS count FROM cloud_agent_context_states
      WHERE owner_user_id='user' AND user_agent_instance_id='proposed' AND active_memory_document_id<>''`)).rows[0].count), 1);
    const replay = await authority.command({
      userId: 'user', deviceId: 'device_b',
      payload: { action: 'recruit', commandId: 'command_1', agentFamilyId: 'family', proposedInstanceId: 'ignored' },
    });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.instance.id, 'proposed');
    await pool.query(`INSERT INTO cloud_user_agent_instance_aliases_v3(user_id,alias_instance_id,canonical_instance_id,reason)
      VALUES('user','legacy_proposed','proposed','test_alias')`);
    const aliasedOverview = await authority.overview({ userId: 'user' });
    assert.deepEqual(aliasedOverview.aliases.map((item) => ({
      aliasInstanceId: item.aliasInstanceId,
      canonicalInstanceId: item.canonicalInstanceId,
      reason: item.reason,
    })), [{ aliasInstanceId: 'legacy_proposed', canonicalInstanceId: 'proposed', reason: 'test_alias' }]);
    const adoptedInactive = await authority.command({
      userId: 'user', deviceId: 'device_a',
      payload: {
        action: 'recruit', commandId: 'command_adopt_inactive', agentFamilyId: 'family',
        proposedInstanceId: 'local_inactive', adoptLocalInstance: true, employmentState: 'inactive',
      },
    });
    assert.equal(adoptedInactive.status, 'confirmed');
    assert.equal(adoptedInactive.instance.id, 'local_inactive');
    assert.equal(adoptedInactive.instance.employmentState, 'inactive');
    assert.equal(adoptedInactive.instance.recruitmentSource, 'local_instance_adoption');
    const conflict = await authority.command({
      userId: 'user', deviceId: 'device_a',
      payload: { action: 'deactivate', commandId: 'command_2', agentInstanceId: 'proposed', expectedStateRevision: 9 },
    });
    assert.equal(conflict.status, 'rejected');
    assert.equal(conflict.code, 'employee_state_conflict');
    assert.equal((await authority.overview({ userId: 'user' })).quota.used, 1);
    assert.equal((await authority.events({ userId: 'user' })).length, 3);
  } finally {
    await pool.end();
  }
});

test('PPT catalog repair promotes stale synced families and canonicalizes legacy employee instances', async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pg = memory.adapters.createPg();
  const pool = new pg.Pool();
  try {
    await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
    await pool.query(await fs.readFile(new URL('../migrations/008_evolution_authority.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/010_cluster_market_evolution.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/011_employee_authority.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/013_multi_memory_task_security.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/017_cloud_sync_v6.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/020_primary_context_memory.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/023_employee_cloud_authority_cutover.sql', import.meta.url), 'utf8'));
    await pool.query(await pgMemMigration('../migrations/040_stage123_authority_closure.sql'));
    await pool.query(await fs.readFile(new URL('../migrations/047_agent_family_classification_version.sql', import.meta.url), 'utf8'));
    await pool.query("INSERT INTO users(id) VALUES('ppt_user'),('legacy_ppt_user'),('duplicate_ppt_user')");
    await pool.query(`INSERT INTO cloud_employee_roster_states(user_id,bootstrap_status,bootstrap_id)
      VALUES('legacy_ppt_user','completed','legacy'),('duplicate_ppt_user','completed','duplicate')`);
    await pool.query(`INSERT INTO cloud_agent_families_v3(
      id,department_id,name,role,status,routable,current_version_id,instance_kind,recruitable,
      default_for_new_user,quota_cost,classification_version
    ) VALUES('ppt','legacy','Old PPT','agent','active',false,'','unavailable',false,false,0,'legacy')`);
    await pool.query(`INSERT INTO cloud_user_agent_instances_v3(
      user_id,id,agent_family_id,status,instance_kind,employment_state,quota_exempt
    ) VALUES('ppt_user','ppt_instance','ppt','active','unavailable','active',true)`);
    await pool.query(`INSERT INTO cloud_agent_families_v3(
      id,department_id,name,role,status,routable,current_version_id,instance_kind,recruitable,
      default_for_new_user,quota_cost,classification_version
    ) VALUES('ppt_research_scout','ppt_department','Legacy PPT Scout','agent','active',true,'legacy_ppt_v1','employee',true,false,1,'legacy')`);
    await pool.query(`INSERT INTO cloud_user_agent_instances_v3(
      user_id,id,agent_family_id,status,instance_kind,employment_state,quota_exempt,state_revision,recruitment_source
    ) VALUES
      ('legacy_ppt_user','legacy_ppt_instance','ppt_research_scout','active','employee','active',false,1,'user'),
      ('duplicate_ppt_user','duplicate_canonical','ppt','inactive','employee','inactive',false,2,'user'),
      ('duplicate_ppt_user','duplicate_legacy','ppt_research_scout','active','employee','active',false,3,'user')`);

    await pool.query(await fs.readFile(new URL('../migrations/049_repair_core_ppt_agent_catalog.sql', import.meta.url), 'utf8'));
    const canonicalMigration = await fs.readFile(new URL('../migrations/053_canonicalize_ppt_employee_instances.sql', import.meta.url), 'utf8');
    assert.match(canonicalMigration, /requires-real-postgres:/);
    assert.match(canonicalMigration, /agent_family_id='ppt'/);
    assert.match(canonicalMigration, /ppt_identity_migration/);
    await rehearsePgMemPptCanonicalization(pool);

    const family = (await pool.query("SELECT * FROM cloud_agent_families_v3 WHERE id='ppt'")).rows[0];
    assert.equal(family.department_id, 'ppt_department');
    assert.equal(family.instance_kind, 'employee');
    assert.equal(family.recruitable, true);
    assert.equal(family.routable, true);
    const instance = (await pool.query("SELECT * FROM cloud_user_agent_instances_v3 WHERE id='ppt_instance'")).rows[0];
    assert.equal(instance.instance_kind, 'employee');
    assert.equal(instance.quota_exempt, false);
    const authority = createPostgresEmployeeAuthority({ pool, apiError });
    const overview = await authority.overview({ userId: 'ppt_user' });
    assert.ok(overview.recruitableFamilies.some((item) => item.id === 'ppt'));
    assert.ok(overview.roster.some((item) => item.agentFamilyId === 'ppt'));
    const migrated = (await pool.query("SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id='legacy_ppt_user'")).rows;
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].id, 'legacy_ppt_instance');
    assert.equal(migrated[0].agent_family_id, 'ppt');
    assert.equal(migrated[0].employment_state, 'active');
    assert.equal(Number(migrated[0].state_revision), 2);
    assert.equal((await pool.query("SELECT event_type FROM cloud_user_agent_recruitment_events WHERE user_id='legacy_ppt_user' AND agent_family_id='ppt'")).rows[0]?.event_type, 'identity_migrated');
    const duplicateOverview = await authority.overview({ userId: 'duplicate_ppt_user' });
    assert.equal(duplicateOverview.roster.filter((item) => item.agentFamilyId === 'ppt').length, 1);
    assert.equal(duplicateOverview.roster[0].id, 'duplicate_canonical');
    assert.equal(duplicateOverview.roster[0].employmentState, 'active');
    assert.equal((await pool.query("SELECT canonical_instance_id FROM cloud_user_agent_instance_aliases_v3 WHERE user_id='duplicate_ppt_user' AND alias_instance_id='duplicate_legacy'")).rows[0]?.canonical_instance_id, 'duplicate_canonical');
    const aliasReactivate = await authority.command({
      userId: 'duplicate_ppt_user', deviceId: 'device_alias',
      payload: {
        action: 'reactivate', commandId: 'reactivate_legacy_ppt_alias', agentInstanceId: 'duplicate_legacy',
        expectedStateRevision: duplicateOverview.roster[0].stateRevision,
      },
    });
    assert.equal(aliasReactivate.instance.id, 'duplicate_canonical');
    assert.equal(aliasReactivate.instance.agentFamilyId, 'ppt');
    const retiredLegacy = (await pool.query("SELECT status,routable,recruitable FROM cloud_agent_families_v3 WHERE id='ppt_research_scout'")).rows[0];
    assert.deepEqual(retiredLegacy, { status: 'retired', routable: false, recruitable: false });
  } finally {
    await pool.end();
  }
});

test('legacy additional general Agent families are retired in favor of multi-instance recruitment', async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pg = memory.adapters.createPg();
  const pool = new pg.Pool();
  try {
    await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
    await pool.query(await fs.readFile(new URL('../migrations/008_evolution_authority.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/011_employee_authority.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/023_employee_cloud_authority_cutover.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/047_agent_family_classification_version.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/048_seed_core_agent_catalog.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/056_seed_additional_general_agents.sql', import.meta.url), 'utf8'));
    await pool.query(await pgMemMigration('../migrations/059_consolidate_general_agent_families.sql'));
    await pool.query("INSERT INTO users(id) VALUES('general_catalog_user')");

    const authority = createPostgresEmployeeAuthority({ pool, apiError });
    const overview = await authority.overview({ userId: 'general_catalog_user' });
    assert.deepEqual(overview.recruitableFamilies.filter((family) => /^general_agent_[123]$/.test(family.id)), []);
    const general = overview.recruitableFamilies.find((family) => family.id === 'general_agent');
    assert.equal(general?.defaultForNewUser, true);
    assert.equal(general?.recruitable, true);
    for (const id of ['general_agent_1', 'general_agent_2', 'general_agent_3']) {
      const retired = (await pool.query('SELECT status,routable,recruitable FROM cloud_agent_families_v3 WHERE id=$1', [id])).rows[0];
      assert.deepEqual(retired, { status: 'retired', routable: false, recruitable: false });
    }
    await pool.query(`UPDATE cloud_agent_families_v3 SET status='retired',instance_kind='employee',recruitable=true
      WHERE id='general_agent_1'`);
    const staleRetiredOverview = await authority.overview({ userId: 'general_catalog_user' });
    assert.equal(staleRetiredOverview.recruitableFamilies.some((family) => family.id === 'general_agent_1'), false);
    assert.equal(overview.roster.length, 0);
  } finally {
    await pool.end();
  }
});

test('agent family display-name migration upgrades generated names and preserves custom profiles', async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pg = memory.adapters.createPg();
  const pool = new pg.Pool();
  try {
    await pool.query('CREATE TABLE users (id text PRIMARY KEY)');
    await pool.query(await fs.readFile(new URL('../migrations/008_evolution_authority.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/011_employee_authority.sql', import.meta.url), 'utf8'));
    await pool.query(await fs.readFile(new URL('../migrations/023_employee_cloud_authority_cutover.sql', import.meta.url), 'utf8'));
    await pool.query(await pgMemMigration('../migrations/078_employee_instance_profile_uniqueness.sql'));
    await pool.query("INSERT INTO users(id) VALUES('display_user'),('compaction_user')");
    await pool.query("INSERT INTO cloud_employee_roster_states(user_id,bootstrap_status,bootstrap_id,roster_revision) VALUES('display_user','completed','display',4)");
    await pool.query("INSERT INTO cloud_employee_roster_states(user_id,bootstrap_status,bootstrap_id,roster_revision) VALUES('compaction_user','completed','compact',7)");
    await pool.query(`INSERT INTO cloud_agent_families_v3(
      id,department_id,name,role,status,routable,instance_kind,recruitable,payload_json
    ) VALUES
      ('general_agent','general','通用 Agent','agent','active',true,'employee',true,'{"name":"通用 Agent"}'),
      ('general_agent_4','general','General Agent 4','agent','active',true,'employee',true,'{"name":"General Agent 4"}'),
      ('ppt','ppt_department','PPT Agent','agent','active',true,'employee',true,'{"name":"PPT Agent"}')`);
    await pool.query(`INSERT INTO cloud_user_agent_instances_v3(
      user_id,id,agent_family_id,status,instance_kind,employment_state,family_instance_seq,display_name,note,payload_json,state_revision
    ) VALUES
      ('display_user','general_default','general_agent','active','employee','active',1,'通用 Agent A','','{"displayName":"通用 Agent A","familyInstanceSeq":1}',2),
      ('display_user','general_custom','general_agent','active','employee','active',2,'Research Lead','custom','{"displayName":"Research Lead","familyInstanceSeq":2,"note":"custom"}',3),
      ('display_user','general_extra_default','general_agent_4','active','employee','active',1,'General Agent 4 A','','{"displayName":"General Agent 4 A","familyInstanceSeq":1}',2),
      ('display_user','general_extra_custom','general_agent_4','active','employee','active',2,'General Agent CEO','custom','{"displayName":"General Agent CEO","familyInstanceSeq":2,"note":"custom"}',3),
      ('display_user','ppt_default','ppt','active','employee','active',1,'PPT Agent A','','{"displayName":"PPT Agent A","familyInstanceSeq":1}',4),
      ('compaction_user','compact_a','general_agent','active','employee','active',0,'Generalist A','','{"displayName":"Generalist A","familyInstanceSeq":0}',1),
      ('compaction_user','compact_b','general_agent','active','employee','active',0,'Generalist A','','{"displayName":"Generalist A","familyInstanceSeq":0}',1),
      ('compaction_user','compact_c','general_agent','active','employee','active',0,'Generalist A','','{"displayName":"Generalist A","familyInstanceSeq":0}',1),
      ('compaction_user','compact_custom','general_agent','active','employee','active',0,'Operations Lead','custom','{"displayName":"Operations Lead","familyInstanceSeq":0,"note":"custom"}',1)`);

    const migration = await fs.readFile(new URL('../migrations/079_agent_family_display_names.sql', import.meta.url), 'utf8');
    assert.match(migration, /requires-real-postgres:/);
    assert.match(migration, /Generalist/);
    assert.match(migration, /PPT Designer/);
    assert.match(migration, /family_instance_seq/);
    await rehearsePgMemAgentFamilyDisplayNames(pool);
    const alignmentMigration = await fs.readFile(new URL('../migrations/080_agent_family_name_alignment.sql', import.meta.url), 'utf8');
    assert.match(alignmentMigration, /requires-real-postgres:/);
    assert.match(alignmentMigration, /General Agent\|通用 Agent/);
    assert.match(alignmentMigration, /PPT Agent\|PPTAgent/);
    await rehearsePgMemAgentFamilyNameAlignment(pool);
    const compactionMigration = await fs.readFile(new URL('../migrations/081_agent_instance_sequence_compaction.sql', import.meta.url), 'utf8');
    assert.match(compactionMigration, /requires-real-postgres:/);
    assert.match(compactionMigration, /row_number\(\) OVER/);
    assert.match(compactionMigration, /idx_cloud_user_agent_instances_unique_family_seq/);
    await rehearsePgMemAgentInstanceSequenceCompaction(pool);

    assert.deepEqual((await pool.query("SELECT id,name FROM cloud_agent_families_v3 WHERE id IN ('general_agent','general_agent_4','ppt') ORDER BY id")).rows, [
      { id: 'general_agent', name: 'Generalist' },
      { id: 'general_agent_4', name: 'Generalist' },
      { id: 'ppt', name: 'PPT Designer' },
    ]);
    assert.deepEqual((await pool.query(`SELECT id,display_name,note,state_revision FROM cloud_user_agent_instances_v3
      WHERE user_id='display_user' ORDER BY id`)).rows.map((row) => ({ ...row, state_revision: Number(row.state_revision) })), [
      { id: 'general_custom', display_name: 'Research Lead', note: 'custom', state_revision: 3 },
      { id: 'general_default', display_name: 'Generalist A', note: '', state_revision: 3 },
      { id: 'general_extra_custom', display_name: 'General Agent CEO', note: 'custom', state_revision: 3 },
      { id: 'general_extra_default', display_name: 'Generalist A', note: '', state_revision: 3 },
      { id: 'ppt_default', display_name: 'PPT Designer A', note: '', state_revision: 5 },
    ]);
    assert.equal(Number((await pool.query("SELECT roster_revision FROM cloud_employee_roster_states WHERE user_id='display_user'")).rows[0].roster_revision), 6);
    assert.deepEqual((await pool.query(`SELECT id,family_instance_seq,display_name,note,state_revision
      FROM cloud_user_agent_instances_v3 WHERE user_id='compaction_user' ORDER BY family_instance_seq,id`)).rows
      .map((row) => ({ ...row, family_instance_seq: Number(row.family_instance_seq), state_revision: Number(row.state_revision) })), [
      { id: 'compact_a', family_instance_seq: 1, display_name: 'Generalist A', note: '', state_revision: 2 },
      { id: 'compact_b', family_instance_seq: 2, display_name: 'Generalist B', note: '', state_revision: 2 },
      { id: 'compact_c', family_instance_seq: 3, display_name: 'Generalist C', note: '', state_revision: 2 },
      { id: 'compact_custom', family_instance_seq: 4, display_name: 'Operations Lead', note: 'custom', state_revision: 2 },
    ]);
    assert.equal(Number((await pool.query("SELECT roster_revision FROM cloud_employee_roster_states WHERE user_id='compaction_user'")).rows[0].roster_revision), 8);
  } finally {
    await pool.end();
  }
});

function apiError(code, message, status = 400) {
  const error = new Error(message || code);
  error.code = code;
  error.status = status;
  return error;
}

async function pgMemMigration(relativeUrl) {
  const sql = await fs.readFile(new URL(relativeUrl, import.meta.url), 'utf8');
  return sql.split(/--\s*requires-real-postgres-tail:[^\r\n]*/i, 1)[0];
}

async function rehearsePgMemPptCanonicalization(pool) {
  await pool.query(`UPDATE cloud_user_agent_instances_v3 SET agent_family_id='ppt',base_agent_version_id='ppt_v1',
    state_revision=state_revision+1,recruitment_source='ppt_identity_migration'
    WHERE user_id='legacy_ppt_user' AND id='legacy_ppt_instance'`);
  await pool.query(`UPDATE cloud_user_agent_instances_v3 SET status='active',employment_state='active',state_revision=state_revision+1
    WHERE user_id='duplicate_ppt_user' AND id='duplicate_canonical'`);
  await pool.query(`INSERT INTO cloud_user_agent_instance_aliases_v3(user_id,alias_instance_id,canonical_instance_id,reason)
    VALUES('duplicate_ppt_user','duplicate_legacy','duplicate_canonical','ppt_identity_migration')`);
  await pool.query(`UPDATE cloud_user_agent_instances_v3 SET status='inactive',instance_kind='unavailable',employment_state='inactive',
    quota_exempt=true,sync_enabled=false WHERE user_id='duplicate_ppt_user' AND id='duplicate_legacy'`);
  await pool.query(`INSERT INTO cloud_user_agent_recruitment_events(
    id,user_id,user_agent_instance_id,agent_family_id,event_type,previous_state,next_state,command_id,reason
  ) VALUES('ppt_identity_migration_legacy','legacy_ppt_user','legacy_ppt_instance','ppt','identity_migrated',
    'legacy_ppt','active','migration:ppt-canonical:legacy_ppt_user','legacy_ppt_family_canonicalized')`);
  await pool.query(`UPDATE cloud_agent_families_v3 SET status='retired',routable=false,instance_kind='unavailable',
    recruitable=false,default_for_new_user=false,quota_cost=0 WHERE id='ppt_research_scout'`);
}

async function rehearsePgMemAgentFamilyDisplayNames(pool) {
  await pool.query(`UPDATE cloud_agent_families_v3
    SET name='Generalist',payload_json='{"name":"Generalist"}'::jsonb,updated_at=now()
    WHERE id='general_agent' AND name<>'Generalist'`);
  await pool.query(`UPDATE cloud_agent_families_v3
    SET name='PPT Designer',payload_json='{"name":"PPT Designer"}'::jsonb,updated_at=now()
    WHERE id='ppt' AND name<>'PPT Designer'`);
  await pool.query(`UPDATE cloud_user_agent_instances_v3
    SET display_name='Generalist A',payload_json='{"displayName":"Generalist A","familyInstanceSeq":1}'::jsonb,
      state_revision=state_revision+1,updated_at=now()
    WHERE user_id='display_user' AND id='general_default' AND display_name='通用 Agent A'`);
  await pool.query(`UPDATE cloud_user_agent_instances_v3
    SET display_name='PPT Designer A',payload_json='{"displayName":"PPT Designer A","familyInstanceSeq":1}'::jsonb,
      state_revision=state_revision+1,updated_at=now()
    WHERE user_id='display_user' AND id='ppt_default' AND display_name='PPT Agent A'`);
  await pool.query(`UPDATE cloud_employee_roster_states SET roster_revision=roster_revision+1,updated_at=now()
    WHERE user_id='display_user'`);
}

async function rehearsePgMemAgentFamilyNameAlignment(pool) {
  await pool.query(`UPDATE cloud_agent_families_v3
    SET name='Generalist',payload_json='{"name":"Generalist"}'::jsonb,updated_at=now()
    WHERE id='general_agent_4' AND name='General Agent 4'`);
  await pool.query(`UPDATE cloud_user_agent_instances_v3
    SET display_name='Generalist A',payload_json='{"displayName":"Generalist A","familyInstanceSeq":1}'::jsonb,
      state_revision=state_revision+1,updated_at=now()
    WHERE user_id='display_user' AND id='general_extra_default' AND display_name='General Agent 4 A'`);
  await pool.query(`UPDATE cloud_employee_roster_states SET roster_revision=roster_revision+1,updated_at=now()
    WHERE user_id='display_user'`);
}

async function rehearsePgMemAgentInstanceSequenceCompaction(pool) {
  for (const [id, sequence, displayName] of [
    ['compact_a', 1, 'Generalist A'],
    ['compact_b', 2, 'Generalist B'],
    ['compact_c', 3, 'Generalist C'],
    ['compact_custom', 4, 'Operations Lead'],
  ]) {
    await pool.query(`UPDATE cloud_user_agent_instances_v3 SET family_instance_seq=$1,display_name=$2,
      payload_json=$3::jsonb,state_revision=state_revision+1,updated_at=now()
      WHERE user_id='compaction_user' AND id=$4`, [
      sequence, displayName, JSON.stringify({ familyInstanceSeq: sequence, displayName }), id,
    ]);
  }
  await pool.query(`UPDATE cloud_employee_roster_states SET roster_revision=roster_revision+1,updated_at=now()
    WHERE user_id='compaction_user'`);
}
