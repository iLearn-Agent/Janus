import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const scenarios = [
  { baseline: '0.2.7', shape: 'legacy identity tables and missing modern columns', script: 'scripts/user_agent_migration_rehearsal.mjs' },
  { baseline: '0.2.11', shape: 'empty identity, nonempty mismatch, aliases and deleted sessions', script: 'scripts/message_session_agent_consistency_repair_smoke.mjs' },
  { baseline: '0.2.12', shape: 'legacy session table uniqueness and deleted target reuse', script: 'scripts/database_maintenance_framework_smoke.mjs' },
  { baseline: '0.2.13', shape: 'migration registry drift, second-open idempotence and recovery copy', script: 'scripts/database_maintenance_framework_smoke.mjs' },
  { baseline: '0.2.14', shape: 'alias and canonical primary-session target collision with an existing unique index', script: 'scripts/database_maintenance_framework_smoke.mjs' },
  { baseline: '0.2.15', shape: 'missing account Workspace columns and duplicate primary sessions after default backfill', script: 'scripts/account_workspace_migration_smoke.mjs' },
  { baseline: '0.2.16', shape: 'conversation identity, attachment bindings, duplicate remote events and second-open idempotence', script: 'scripts/conversation_identity_phase6_smoke.mjs' },
  { baseline: '0.2.17', shape: 'fresh database isolation, WAL/key preservation, disk-space refusal, replacement rollback, extended inventory and quarantine restoration', script: 'scripts/database_fresh_fallback_smoke.mjs' },
  { baseline: '0.2.18-wake-to-0.2.27-recovery', shape: 'uBuddy coordination tables, recovery-required constraint expansion, wake idempotence, bounded recovery escalation, second-open preservation and recovery-copy repair', script: 'scripts/ubuddy_sleep_wake_coordination_smoke.mjs' },
  { baseline: '0.2.18-agent-allocation', shape: 'uBuddy atomic Agent reservations, persisted FIFO waiting requests, task preservation, recovery-copy repair and second-open integrity', script: 'scripts/ubuddy_agent_allocation_smoke.mjs' },
  { baseline: '0.2.20-ubuddy-coordination-contract-v2', shape: 'reservation leases, exact/family binding, priority waiting, legacy Plan normalization, dispatch metadata migration, persistent planning jobs and recovery-copy preservation', script: 'scripts/ubuddy_agent_allocation_smoke.mjs' },
  { baseline: '0.2.20-ubuddy-background-planning', shape: 'persistent background planning materialization, leader selection, synthesis ownership and immediate secretary response', script: 'scripts/ubuddy_background_planning_smoke.mjs' },
  { baseline: '0.2.18-chat-groups', shape: 'additive natural-person group chats, withdrawal metadata/content preservation, outbox idempotence, projection preservation and second-open integrity', script: 'scripts/chat_groups_migration_smoke.mjs' },
  { baseline: '0.2.18-social-directory', shape: 'account-social mixed-member chats, startup organization preference, recovery-copy preservation and second-open integrity', script: 'scripts/chat_groups_migration_smoke.mjs' },
  { baseline: '0.2.21-conversation-archive', shape: 'recoverable per-user group archive, idempotent outbox, active-message auto-return, ended-group retention and recovery-copy preservation', script: 'scripts/chat_groups_migration_smoke.mjs' },
  { baseline: '0.2.22-contact-labels', shape: 'private contact remarks plus organization, natural-group and work-group display-name overrides with recovery-copy preservation', script: 'scripts/chat_groups_migration_smoke.mjs' },
  { baseline: '0.2.23-ubuddy-profile-social', shape: 'viewer-scoped 24-hour profile cache, idempotent publication outbox, cloud revision archival and recovery-copy preservation', script: 'scripts/ubuddy_capability_profile_social_smoke.mjs' },
  { baseline: '0.2.24-ubuddy-profile-history', shape: 'owned immutable Profile revisions, one-active archival, Skill-hash idempotence, asynchronous failure fallback and privacy-review gating', script: 'scripts/ubuddy_profile_history_smoke.mjs' },
  { baseline: '0.2.24-profile-update-outbox', shape: 'offline account Profile latest-intent persistence, restart-safe retry, portable avatar validation and second-open integrity', script: 'scripts/profile_update_outbox_smoke.mjs' },
  { baseline: '0.2.25-ubuddy-dispatch-v3', shape: 'saved recipient selection, command-ledger recovery, legacy empty delegation request ids, partial uniqueness, cloud duplicate delivery and second-open preservation', script: 'scripts/ubuddy_direct_dispatch_smoke.mjs' },
  { baseline: '0.2.25-account-principals', shape: 'personal and organization Account projection, exact direct/group/Agent message preservation, security-domain isolation, contact/principal separation, backup and second-open idempotence', script: 'scripts/account_principal_isolation_smoke.mjs' },
  { baseline: '0.2.13-general-catalog-to-0.2.27-repair', shape: 'numbered Generalist catalog revival after the original consolidation, canonical family rebinding, sequence collision avoidance, retired tombstones and second-open idempotence', script: 'scripts/general_agent_family_consolidation_smoke.mjs' },
  { baseline: '0.2.26-agent-display-names', shape: 'Generalist and PPT Designer alias-template alignment, contiguous A/B/C instance compaction after late zero-sequence sync, custom-name preservation, exact message and Memory preservation, and second-open idempotence', script: 'scripts/agent_family_display_names_smoke.mjs' },
  { baseline: '0.2.24-bounded-delivery-rework', shape: 'additive delivery review tables, core inventory preservation, payload-equivalent idempotence and second-open integrity', script: 'scripts/ubuddy_bounded_delivery_rework_smoke.mjs' },
  { baseline: '0.2.23-agent-single-window', shape: 'duplicate direct Agent sessions, writable task-workspace primary collisions, conversation aliases, Codex thread lineage, same-user same-family multi-live alias-cycle canonicalization including four-node transitive device Context/Memory state, legacy alias Context and Memory reference repair with pre-existing negative local-only version numbers, atomic Message/Context rebind, irreconcilable ownership rollback, cross-family rollback, recovery-copy preservation and idempotence', script: 'scripts/agent_single_window_migration_smoke.mjs' },
  { baseline: '0.2.23-agent-alias-context-state-v4', shape: 'nine-node same-user same-family live Agent alias cycle with three missing single-window tables, Session/Memory/Context/Message/account-device Context State projection, delegation history Session rebind, private delegation metadata relocation, shadow preflight, repair-copy preservation and second-open idempotence', script: 'scripts/database_alias_context_state_v4_smoke.mjs' },
  { baseline: '0.2.20-large-files', shape: 'additive resumable metadata, legacy 60 MB compatibility, resume receipts, large local path import and installer safety', script: 'scripts/resumable_large_file_smoke.mjs' },
  { baseline: '0.2.18-evidence-outbox', shape: 'account-isolated Evidence scheduling metadata, row preservation, retry backoff and second-open idempotence', script: 'scripts/evolution_evidence_outbox_smoke.mjs' },
  { baseline: 'sync-v6', shape: 'database protocol negotiation, missing contract and incompatible capability rejection', script: 'scripts/database_sync_contract_smoke.mjs' },
  { baseline: 'fresh-sync', shape: 'new database performs a pull-only reconciliation before any upload resumes', script: 'scripts/database_fresh_pull_only_sync_smoke.mjs' },
  { baseline: 'runtime-merge', shape: 'server-originated Agent alias merge preserves duplicate sessions, messages and equivalent contexts', script: 'scripts/database_runtime_identity_merge_smoke.mjs' },
  { baseline: 'shadow-preflight', shape: 'an unknown migration failure is detected on a copy before the active database or backup set changes', script: 'scripts/database_shadow_preflight_smoke.mjs' },
  { baseline: 'registry', shape: 'machine-readable migration declarations and unsafe identity rewrite ordering guard', script: 'scripts/database_migration_guard.mjs' },
  { baseline: '1.0.0-memory-context', shape: 'mixed-memory messages sharing one stale context are routed to each memory exact context on startup and recovery-copy repair without inventory loss', script: 'scripts/memory_context_pointer_repair_smoke.mjs' },
  { baseline: '1.0.0-message-memory-turn-binding', shape: 'orphan Memory references and cross-Memory assistant responses are rebound from exact Context and model-execution lineage without changing message identity or content', script: 'scripts/memory_context_pointer_repair_smoke.mjs' },
  { baseline: '1.0.0-attached-skills', shape: 'additive Skill package registry, stable package and Skill identity, department and family inheritance, employee overrides, assignment persistence, second-open idempotence and database integrity', script: 'scripts/attached_skill_management_smoke.mjs' },
  { baseline: '1.0.0-organization-message-research', shape: 'additive encrypted organization research cache metadata, lease expiry, context expiry, tombstones, duplicate delivery, plaintext-at-rest rejection and core inventory preservation', script: 'scripts/organization_message_research_smoke.mjs' },
  { baseline: '1.0.0-follower', shape: 'additive local Follower and cloud-evolution projection tables, session/message preservation, recovery-copy repair, second-open idempotence and integrity checks', script: 'scripts/follower/historical_upgrade_smoke.mjs' },
];

const results = [];
for (const scenario of scenarios) {
  const result = spawnSync(process.execPath, [scenario.script], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 0, `${scenario.baseline} ${scenario.shape}\n${result.stdout}\n${result.stderr}`);
  results.push({ ...scenario, status: 'passed' });
}
process.stdout.write(`${JSON.stringify({ status: 'passed', scenarios: results }, null, 2)}\n`);
