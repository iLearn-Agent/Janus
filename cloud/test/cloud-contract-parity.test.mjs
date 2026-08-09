import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';

import { createSyncV6Service } from '../src/modules/sync/syncV6.mjs';
import { CLOUD_SCHEMA } from '../../src/cloud/modules/persistence/infrastructure/cloudSchema.js';
import {
  cloudEmployeeCapability,
  CLOUD_CONTEXT_KINDS,
  CLOUD_MEMORY_MAPPING_STATES,
  CLOUD_MEMORY_SCOPES,
  CLOUD_PERFORMANCE_LEVELS,
  CLOUD_LEADERSHIP_LEVELS,
} from '../../src/shared/cloudContracts.js';
import { EVIDENCE_REJECTION_KINDS } from '../../src/shared/evolution/contracts.js';

test('PostgreSQL and embedded SQLite expose the same logical multi-Memory contract', async () => {
  const postgres = await fs.readFile(new URL('../database/baseline-sync8.sql', import.meta.url), 'utf8');
  const evidenceContract = postgres;
  const evidenceUsageEvents = postgres;
  const evidenceSourceAuthority = postgres;
  const evidenceCollectionLedger = postgres;
  const leadershipContract = postgres;
  const clusterAlignment = postgres;
  const performanceV2 = postgres;
  const realCanary = postgres;
  const defaultCanary = postgres;
  const stage123 = postgres;
  const chatContextState = postgres;
  for (const source of [postgres, CLOUD_SCHEMA]) {
    assert.match(source, /cloud_agent_context_spaces/);
    assert.match(source, /cloud_memory_sync_mappings/);
    assert.match(source, /memory_document_id/);
    assert.match(source, /user_agent_instance_id/);
    for (const value of [...CLOUD_CONTEXT_KINDS,...CLOUD_MEMORY_MAPPING_STATES,...CLOUD_MEMORY_SCOPES,...CLOUD_PERFORMANCE_LEVELS]) {
      assert.ok(source.includes(`'${value}'`), `${value} is absent from one cloud schema`);
    }
  }
  for (const source of [stage123, CLOUD_SCHEMA]) {
    assert.match(source, /cloud_agent_context_states/);
    assert.match(source, /active_memory_document_id/);
    assert.match(source, /state_revision/);
    assert.match(source, /idx_cloud_one_active_general_memory/);
  }
  for (const source of [chatContextState, CLOUD_SCHEMA]) {
    assert.match(source, /cloud_chat_context_states/);
    assert.match(source, /context_epoch/);
    assert.match(source, /reset_after_message_id/);
    assert.match(source, /provider_compaction_detected/);
  }
  assert.match(postgres, /idx_cloud_memory_documents_slot_identity_v3/);
  assert.match(postgres, /INSERT INTO public\.account_workspaces\(id,workspace_kind,name,status\)[\s\S]*?'workspace_personal'/,
    'the consolidated PostgreSQL baseline must preserve the personal Workspace seed required by the new-user trigger');
  assert.doesNotMatch(postgres, /cloud_agent_context_spaces_legacy_v20/);
  assert.doesNotMatch(postgres, /cloud_memory_sync_mappings_legacy_v20/);
  assert.match(CLOUD_SCHEMA, /UNIQUE\(user_id,user_agent_instance_id,scope,slot_no,task_run_id,project_id,relationship_id\)/);
  assert.equal(/private_key/.test(postgres.match(/CREATE TABLE public\.cloud_memory_sync_mappings[\s\S]*?\);/)?.[0] || ''), false);
  assert.equal(/private_key/.test(CLOUD_SCHEMA.match(/CREATE TABLE IF NOT EXISTS cloud_memory_sync_mappings[\s\S]*?\);/)?.[0] || ''), false);
  for (const value of EVIDENCE_REJECTION_KINDS) {
    assert.ok(evidenceContract.includes(`'${value}'`), `${value} is absent from the PostgreSQL evidence contract`);
    assert.ok(CLOUD_SCHEMA.includes(`'${value}'`), `${value} is absent from the embedded evidence contract`);
  }
  assert.match(evidenceContract, /rejection_kind/);
  assert.match(evidenceContract, /transition_reason/);
  for (const source of [evidenceUsageEvents, CLOUD_SCHEMA]) assert.match(source, /cloud_evolution_evidence_usage_events/);
  for (const source of [evidenceSourceAuthority, CLOUD_SCHEMA]) assert.match(source, /cloud_task_events/);
  for (const source of [evidenceCollectionLedger,CLOUD_SCHEMA]) {
    assert.match(source,/personal_threshold_eligible/);
    assert.match(source,/eligibility_policy_version/);
    assert.match(source,/idx_cloud_evidence_personal_threshold/);
  }
  for (const source of [leadershipContract, CLOUD_SCHEMA]) {
    assert.match(source, /cloud_agent_leadership_levels/);
    assert.match(source, /cloud_agent_leadership_evaluations/);
    assert.match(source, /cloud_leadership_promotion_actions/);
    assert.match(source, /cloud_leadership_appeals/);
    for (const value of CLOUD_LEADERSHIP_LEVELS) assert.ok(source.includes(`'${value}'`), `${value} is absent from one leadership schema`);
  }
  for (const source of [clusterAlignment,CLOUD_SCHEMA]) {
    assert.match(source,/minimum_user_count/);
    assert.match(source,/maximum_user_weight_share/);
    assert.match(source,/cluster_active_synced_mandatory_v1/);
  }
  for (const source of [performanceV2,CLOUD_SCHEMA]) {
    assert.match(source,/source_version_id/);
    assert.match(source,/validation_status/);
    assert.match(source,/cloud_performance_backfill_cursors/);
    assert.match(source,/idx_cloud_performance_authoritative_source/);
  }
  for(const source of [realCanary,CLOUD_SCHEMA]){
    assert.match(source,/cloud_market_canary_opt_ins/);
    assert.match(source,/cloud_market_canary_assignments/);
    assert.match(source,/cloud_market_canary_evaluations/);
  }
  for(const source of [defaultCanary,CLOUD_SCHEMA])assert.match(source,/market_canary_real_user_default_on_v2/);
});

test('Sync V6 advertises the multi-Memory and chat context state entity types', () => {
  const capability = createSyncV6Service({ pool: null, apiError: () => null,
    env: { JANUS_SYNC_REQUIRE_CLIENT_CONTRACT: '0' } }).capabilities();
  assert.deepEqual(capability.employees, cloudEmployeeCapability(true));
  assert.deepEqual(capability.multiMemory, {
    enabled: true, contractVersion: 2, contextSpaces: true, cloudKeyMappings: true,
    accountContextState: true, offlineLocalWrites: true,
  });
  assert.ok(capability.entityTypes.includes('agent_context_space'));
  assert.ok(capability.entityTypes.includes('agent_context_state'));
  assert.ok(capability.entityTypes.includes('chat_context_state'));
  assert.ok(capability.entityTypes.includes('memory_sync_mapping'));
  assert.ok(capability.entityTypes.includes('task_event'));
});
