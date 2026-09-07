import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  CLOUD_DATABASE_MIGRATIONS,
  DATABASE_MIGRATIONS,
  assertCloudDatabaseMigrationRegistry,
  assertDatabaseMigrationRegistry,
} from '../src/main/modules/persistence/infrastructure/databaseMigrationRegistry.js';
import {
  DATABASE_SYNC_CAPABILITIES,
  DATABASE_SYNC_CURRENT_MIGRATION_ID,
  DATABASE_SYNC_MINIMUM_APP_VERSION,
  DATABASE_SYNC_PROTOCOL_VERSION,
  assessDatabaseClientCompatibility,
  createDatabaseClientContract,
} from '../src/shared/databaseEvolutionContract.js';

const repositoryAgentInstructions = fs.readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
const evolutionPolicy = fs.readFileSync(new URL('../docs/database-evolution-policy.md', import.meta.url), 'utf8');
const evolutionSkill = fs.readFileSync(new URL('../.agents/skills/safe-database-evolution/SKILL.md', import.meta.url), 'utf8');
assert.match(repositoryAgentInstructions, /safe-database-evolution\/SKILL\.md/,
  'repository Agent instructions must require the database evolution Skill');
assert.match(evolutionPolicy, /collisions produced by target values/i,
  'database evolution policy must require projected target-value collision analysis');
assert.match(evolutionSkill, /name: safe-database-evolution/,
  'the safe database evolution Skill must remain installed in the repository');
assert.match(evolutionSkill, /database_historical_upgrade_matrix\.mjs/,
  'the safe database evolution Skill must require the historical upgrade matrix');

assert.equal(assertDatabaseMigrationRegistry(), true);
assert.equal(assertCloudDatabaseMigrationRegistry(), true);
assert.equal(CLOUD_DATABASE_MIGRATIONS.at(-1)?.id, '096_voice_call_state.sql');
assert.deepEqual(
  [...CLOUD_DATABASE_MIGRATIONS.find((migration) => migration.id === '076_account_principal_isolation.sql').risk.requiredCapabilities].sort(),
  [...DATABASE_SYNC_CAPABILITIES].sort(),
);
assert.deepEqual(CLOUD_DATABASE_MIGRATIONS.find((migration) => migration.id === '078_employee_instance_profile_uniqueness.sql')
  .risk.requiredCapabilities, ['employee-instance-profile-uniqueness-v1']);
assert.deepEqual(CLOUD_DATABASE_MIGRATIONS.find((migration) => migration.id === '088_follower_raw_report_evolution.sql').risk.requiredCapabilities,
  ['follower-report-projection-v1', 'follower-raw-report-v1', 'follower-system-service-v1', 'follower-evidence-v1']);
assert.deepEqual(CLOUD_DATABASE_MIGRATIONS.at(-1).risk.requiredCapabilities,
  ['voice-call-state-v1']);
assert.equal(CLOUD_DATABASE_MIGRATIONS.find((migration) => migration.id === '090_message_memory_turn_binding_repair.sql').risk.preservationRules
  .includes('message_ids_roles_content_visibility_and_created_timestamps_are_unchanged'), true);
assert.equal(CLOUD_DATABASE_MIGRATIONS.find((migration) => migration.id === '066_resumable_large_files.sql')
  ?.risk.requiredCapabilities.includes('resumable-file-transfer-v1'), true);
assert.equal(CLOUD_DATABASE_MIGRATIONS.find((migration) => migration.id === '067_social_conversation_preferences.sql')
  ?.risk.requiredCapabilities.includes('conversation-inbox-archive-v1'), true);
assert.equal(CLOUD_DATABASE_MIGRATIONS.find((migration) => migration.id === '068_delegation_realtime_execution.sql')
  ?.risk.requiredCapabilities.includes('delegation-realtime-sse-v1'), true);
assert.equal(CLOUD_DATABASE_MIGRATIONS.find((migration) => migration.id === '068_delegation_realtime_execution.sql')
  ?.risk.requiredCapabilities.includes('delegation-execution-lease-v1'), true);
assert.equal(CLOUD_DATABASE_MIGRATIONS.find((migration) => migration.id === '069_direct_delegation_files.sql')
  ?.risk.requiredCapabilities.includes('direct-delegation-files-v1'), true);
assert.equal(CLOUD_DATABASE_MIGRATIONS.find((migration) => migration.id === '070_contact_membership_display_names.sql')
  ?.risk.requiredCapabilities.includes('contact-remarks-v1'), true);
assert.equal(CLOUD_DATABASE_MIGRATIONS.find((migration) => migration.id === '070_contact_membership_display_names.sql')
  ?.risk.requiredCapabilities.includes('membership-display-names-v1'), true);
assert.equal(CLOUD_DATABASE_MIGRATIONS.find((migration) => migration.id === '071_ubuddy_capability_profiles.sql')
  ?.risk.requiredCapabilities.includes('ubuddy-capability-profile-v1'), true);
assert.equal(CLOUD_DATABASE_MIGRATIONS.find((migration) => migration.id === '074_agent_instance_alias_cycle_repair.sql')
  ?.risk.requiredCapabilities.includes('canonical-agent-identity-v1'), true);
assert.equal(CLOUD_DATABASE_MIGRATIONS.find((migration) => migration.id === '075_sync_alias_history_snapshot_repair.sql')
  ?.risk.preservationRules.includes('empty_cursor_clients_receive_reset_required_and_apply_the_current_projection_before_later_changes'), true);
const current = DATABASE_MIGRATIONS.find((migration) => migration.id === DATABASE_SYNC_CURRENT_MIGRATION_ID);
assert.ok(current, `${DATABASE_SYNC_CURRENT_MIGRATION_ID} must be registered`);
assert.equal(current.riskDeclarationSource, 'explicit');
assert.equal(current.risk.minimumSyncProtocol, DATABASE_SYNC_PROTOCOL_VERSION);
assert.deepEqual(current.risk.requiredCapabilities, ['organization-message-research-v1']);

for (const migration of DATABASE_MIGRATIONS) {
  assert.equal(migration.risk.idempotent, true, `${migration.id} must be idempotent`);
  assert.equal(migration.risk.rollbackSafe, true, `${migration.id} must be rollback safe`);
  assert.match(migration.riskChecksum, /^[a-f0-9]{64}$/, `${migration.id} must have a deterministic risk checksum`);
  assert.ok(migration.risk.preservationRules.length, `${migration.id} must declare preservation rules`);
  if (migration.risk.rewritesColumns.length) {
    assert.notEqual(migration.risk.collisionStrategy, 'not_applicable', `${migration.id} rewrites columns without a collision strategy`);
  }
}

const compatible = assessDatabaseClientCompatibility(createDatabaseClientContract({
  appVersion: DATABASE_SYNC_MINIMUM_APP_VERSION,
  migrationIds: DATABASE_MIGRATIONS.map((migration) => migration.id),
}));
assert.equal(compatible.compatible, true);
assert.equal(assessDatabaseClientCompatibility({}, { requireContract: true }).compatible, false);

const migrationSource = fs.readFileSync(new URL('../src/main/modules/persistence/infrastructure/sqliteMigrations.js', import.meta.url), 'utf8');
const singleWindowMigrationOffset = migrationSource.indexOf('function migrateAgentSingleWindowContinuity');
const dropOffset = migrationSource.indexOf("DROP INDEX IF EXISTS idx_sessions_one_primary_agent", singleWindowMigrationOffset);
const canonicalizeOffset = migrationSource.indexOf('canonicalizeAgentConversationAliasReferences(db, canonicalAliases)', dropOffset);
const repairOffset = migrationSource.indexOf('repairPrimaryAgentSessionUniqueness(db)', canonicalizeOffset);
const recreateOffset = migrationSource.indexOf('CREATE UNIQUE INDEX idx_sessions_one_primary_agent', repairOffset);
assert.ok(singleWindowMigrationOffset >= 0 && dropOffset >= 0 && dropOffset < canonicalizeOffset,
  'the primary-session unique index must be removed before Agent identity canonicalization');
assert.ok(canonicalizeOffset < repairOffset && repairOffset < recreateOffset,
  'Agent identity canonicalization must be followed by deterministic duplicate repair before the unique index is recreated');

const runtimeIdentitySource = fs.readFileSync(new URL('../src/main/modules/persistence/infrastructure/userAgentIdentityStoreMethods.js', import.meta.url), 'utf8');
const bindOffset = runtimeIdentitySource.indexOf('bindCanonicalAgentInstance');
const runtimeDropOffset = runtimeIdentitySource.indexOf('DROP INDEX IF EXISTS idx_sessions_one_primary_agent', bindOffset);
const runtimeRewriteOffset = runtimeIdentitySource.indexOf('rewriteAgentInstanceReferences(this.db, aliasId, canonicalId)', bindOffset);
const runtimeRepairOffset = runtimeIdentitySource.indexOf('repairPrimaryAgentSessionUniqueness(this.db)', runtimeRewriteOffset);
const runtimeRecreateOffset = runtimeIdentitySource.indexOf('CREATE UNIQUE INDEX idx_sessions_one_primary_agent', runtimeRepairOffset);
assert.ok(bindOffset >= 0 && runtimeDropOffset < runtimeRewriteOffset && runtimeRewriteOffset < runtimeRepairOffset
  && runtimeRepairOffset < runtimeRecreateOffset,
'runtime/server-originated Agent identity merges must preserve sessions before restoring the primary-session constraint');

process.stdout.write('Database migration guard passed.\n');
