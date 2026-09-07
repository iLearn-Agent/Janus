export const CLOUD_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS server_records (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sync_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sync_batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  cursor_from TEXT NOT NULL DEFAULT '',
  cursor_to TEXT NOT NULL DEFAULT '',
  item_count INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS cloud_sessions (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS cloud_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS cloud_projects_v2 (
  user_id TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, device_id, id)
);

CREATE TABLE IF NOT EXISTS cloud_conversations_v2 (
  user_id TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL,
  conversation_type TEXT NOT NULL DEFAULT 'ordinary',
  project_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, device_id, id)
);

CREATE TABLE IF NOT EXISTS cloud_messages_v2 (
  user_id TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, device_id, id)
);

CREATE TABLE IF NOT EXISTS cloud_transcripts_v2 (
  user_id TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, device_id, id)
);

CREATE TABLE IF NOT EXISTS cloud_model_executions_v2 (
  user_id TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  request_message_id TEXT NOT NULL DEFAULT '',
  response_message_id TEXT NOT NULL DEFAULT '',
  task_run_id TEXT NOT NULL DEFAULT '',
  task_node_id TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  execution_kind TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL DEFAULT '',
  effective_model TEXT NOT NULL DEFAULT '',
  reasoning_effort TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, device_id, id)
);

CREATE TABLE IF NOT EXISTS cloud_file_refs_v2 (
  user_id TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL,
  sha256 TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  task_run_id TEXT NOT NULL DEFAULT '',
  task_node_id TEXT NOT NULL DEFAULT '',
  relation_type TEXT NOT NULL DEFAULT 'intermediate',
  source_kind TEXT NOT NULL DEFAULT '',
  original_name TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  local_path TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, device_id, id)
);

CREATE TABLE IF NOT EXISTS cloud_agent_families_v3 (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'agent',
  status TEXT NOT NULL DEFAULT 'active',
  routable INTEGER NOT NULL DEFAULT 0,
  instance_kind TEXT NOT NULL DEFAULT 'unavailable',
  recruitable INTEGER NOT NULL DEFAULT 0,
  default_for_new_user INTEGER NOT NULL DEFAULT 0,
  quota_cost INTEGER NOT NULL DEFAULT 0,
  current_version_id TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS cloud_agent_versions_v3 (
  id TEXT PRIMARY KEY,
  agent_family_id TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT '',
  UNIQUE(agent_family_id, content_hash)
);

CREATE TABLE IF NOT EXISTS cloud_user_agent_instances_v3 (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL,
  base_agent_version_id TEXT NOT NULL DEFAULT '',
  active_personal_skill_version_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  instance_kind TEXT NOT NULL DEFAULT 'employee',
  employment_state TEXT NOT NULL DEFAULT 'active',
  quota_exempt INTEGER NOT NULL DEFAULT 0,
  recruited_at TEXT NOT NULL DEFAULT '',
  deactivated_at TEXT NOT NULL DEFAULT '',
  last_state_changed_at TEXT NOT NULL DEFAULT '',
  state_revision INTEGER NOT NULL DEFAULT 1,
  recruitment_source TEXT NOT NULL DEFAULT 'migration',
  policy_version TEXT NOT NULL DEFAULT 'employee_cloud_authority_v1',
  sync_enabled INTEGER NOT NULL DEFAULT 1,
  personal_evolution_consent INTEGER NOT NULL DEFAULT 1,
  cluster_contribution_consent INTEGER NOT NULL DEFAULT 0,
  personal_skill_auto_activate INTEGER NOT NULL DEFAULT 0,
  source_device_id TEXT NOT NULL DEFAULT '',
  family_instance_seq INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, id),
  CHECK(status IN ('active','inactive')),
  CHECK(instance_kind IN ('employee','system','governance','unavailable')),
  CHECK(employment_state IN ('active','inactive')),
  CHECK(status = employment_state),
  CHECK(state_revision >= 1)
);

CREATE INDEX IF NOT EXISTS idx_cloud_user_agent_instances_family
  ON cloud_user_agent_instances_v3(user_id, agent_family_id, created_at, id);

CREATE TABLE IF NOT EXISTS cloud_user_evolution_preferences (
  user_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  policy_version TEXT NOT NULL DEFAULT 'evolution_default_on_account_pause_v1',
  state_revision INTEGER NOT NULL DEFAULT 1,
  last_command_id TEXT NOT NULL DEFAULT '',
  paused_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(state_revision >= 1)
);

CREATE TABLE IF NOT EXISTS cloud_user_agent_skill_versions_v3 (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  base_agent_version_id TEXT NOT NULL DEFAULT '',
  parent_version_id TEXT NOT NULL DEFAULT '',
  source_evolution_run_id TEXT NOT NULL DEFAULT '',
  authority TEXT NOT NULL DEFAULT 'legacy_imported',
  stability_status TEXT NOT NULL DEFAULT 'candidate',
  overlay_hash TEXT NOT NULL DEFAULT '',
  effective_skill_hash TEXT NOT NULL DEFAULT '',
  compiler_version TEXT NOT NULL DEFAULT 'overlay_concat_v1',
  status TEXT NOT NULL DEFAULT 'candidate',
  activated_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, id),
  CHECK(authority IN ('cloud','legacy_imported')),
  CHECK(stability_status IN ('candidate','stable')),
  CHECK(status IN ('candidate','active','archived','rejected'))
);

CREATE TABLE IF NOT EXISTS cloud_personal_version_commands (
  user_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_version_id TEXT NOT NULL DEFAULT '',
  expected_active_version_id TEXT NOT NULL DEFAULT '',
  previous_active_version_id TEXT NOT NULL DEFAULT '',
  result_active_version_id TEXT NOT NULL DEFAULT '',
  actor_device_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'confirmed',
  error_code TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(user_id,command_id),
  CHECK(action IN ('activate','rollback')),
  CHECK(status IN ('confirmed','rejected'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_personal_version_commands_instance
  ON cloud_personal_version_commands(user_id,user_agent_instance_id,created_at DESC);

CREATE TABLE IF NOT EXISTS cloud_user_agent_recruitment_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL DEFAULT '',
  agent_family_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  previous_state TEXT NOT NULL DEFAULT '',
  next_state TEXT NOT NULL DEFAULT '',
  quota_before INTEGER NOT NULL DEFAULT 0,
  quota_after INTEGER NOT NULL DEFAULT 0,
  command_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT '',
  UNIQUE(user_id, command_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_recruitment_events_user
  ON cloud_user_agent_recruitment_events(user_id, created_at);

CREATE TABLE IF NOT EXISTS cloud_employee_roster_states (
  user_id TEXT PRIMARY KEY,
  roster_revision INTEGER NOT NULL DEFAULT 0 CHECK(roster_revision >= 0),
  bootstrap_status TEXT NOT NULL DEFAULT 'pending' CHECK(bootstrap_status IN ('pending','completed')),
  bootstrap_id TEXT NOT NULL DEFAULT '',
  policy_version TEXT NOT NULL DEFAULT 'employee_cloud_authority_v1',
  bootstrapped_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS cloud_user_agent_instance_aliases_v3 (
  user_id TEXT NOT NULL,
  alias_instance_id TEXT NOT NULL,
  canonical_instance_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'cross_device_family_conflict',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, alias_instance_id)
);

CREATE TABLE IF NOT EXISTS cloud_memory_documents_v3 (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL DEFAULT '',
  cloud_key TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'general',
  slot_no INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL DEFAULT 'memory0.md',
  task_run_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  relationship_id TEXT NOT NULL DEFAULT '',
  delegation_id TEXT NOT NULL DEFAULT '',
  group_id TEXT NOT NULL DEFAULT '',
  relationship_user_id TEXT NOT NULL DEFAULT '',
  context_space_id TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'agent_private',
  source_conversation_cursor TEXT NOT NULL DEFAULT '',
  encryption_key_id TEXT NOT NULL DEFAULT '',
  consent_scope_json TEXT NOT NULL DEFAULT '{}',
  current_version_id TEXT NOT NULL DEFAULT '',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  sync_enabled INTEGER NOT NULL DEFAULT 1,
  allow_personal_evolution INTEGER NOT NULL DEFAULT 1,
  allow_cluster_evolution INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, id),
  UNIQUE(user_id,user_agent_instance_id,scope,slot_no,task_run_id,project_id,relationship_id),
  FOREIGN KEY(user_id,user_agent_instance_id) REFERENCES cloud_user_agent_instances_v3(user_id,id) ON DELETE CASCADE,
  CHECK(scope IN ('general','task','project','relationship')),
  CHECK(slot_no >= 0),
  CHECK(lifecycle_state IN ('active','inactive','archived')),
  CHECK(visibility IN ('agent_private','owner_private','work_collaborators','work_leadership','work_participants','work_summary'))
);

CREATE TABLE IF NOT EXISTS cloud_memory_document_versions_v3 (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  memory_document_id TEXT NOT NULL,
  version_no INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL DEFAULT '',
  base_version_id TEXT NOT NULL DEFAULT '',
  parent_version_id TEXT NOT NULL DEFAULT '',
  branch_id TEXT NOT NULL DEFAULT 'main',
  conflict_state TEXT NOT NULL DEFAULT 'none',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, id),
  UNIQUE(user_id, memory_document_id, version_no),
  FOREIGN KEY(user_id,memory_document_id) REFERENCES cloud_memory_documents_v3(user_id,id) ON DELETE CASCADE,
  CHECK(version_no >= 1)
);

CREATE TABLE IF NOT EXISTS cloud_memory_document_aliases_v3 (
  user_id TEXT NOT NULL,
  alias_document_id TEXT NOT NULL,
  canonical_document_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'cross_device_memory_conflict',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, alias_document_id)
);

CREATE TABLE IF NOT EXISTS cloud_agent_context_spaces (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  context_kind TEXT NOT NULL CHECK(context_kind IN ('general_memory','project','task','relationship')),
  memory_document_id TEXT,
  project_id TEXT NOT NULL DEFAULT '',
  task_run_id TEXT NOT NULL DEFAULT '',
  delegation_id TEXT NOT NULL DEFAULT '',
  group_id TEXT NOT NULL DEFAULT '',
  relationship_user_id TEXT NOT NULL DEFAULT '',
  lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle_state IN ('active','inactive','archived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id,id),
  FOREIGN KEY(user_id,user_agent_instance_id) REFERENCES cloud_user_agent_instances_v3(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,memory_document_id) REFERENCES cloud_memory_documents_v3(user_id,id) ON DELETE CASCADE,
  CHECK(
    (context_kind='general_memory' AND memory_document_id IS NOT NULL AND project_id='' AND task_run_id='' AND relationship_user_id='') OR
    (context_kind='project' AND memory_document_id IS NULL AND project_id<>'' AND task_run_id='' AND relationship_user_id='') OR
    (context_kind='task' AND memory_document_id IS NULL AND task_run_id<>'' AND project_id='' AND relationship_user_id='') OR
    (context_kind='relationship' AND memory_document_id IS NULL AND relationship_user_id<>'' AND project_id='' AND task_run_id='')
  )
);
CREATE TABLE IF NOT EXISTS cloud_memory_sync_mappings (
  owner_user_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  cloud_key TEXT NOT NULL,
  memory_document_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','revoked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(owner_user_id,user_agent_instance_id,cloud_key),
  FOREIGN KEY(owner_user_id,user_agent_instance_id) REFERENCES cloud_user_agent_instances_v3(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_user_id,memory_document_id) REFERENCES cloud_memory_documents_v3(user_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS cloud_agent_context_states (
  owner_user_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  primary_conversation_id TEXT NOT NULL DEFAULT '',
  active_context_space_id TEXT NOT NULL DEFAULT '',
  active_memory_document_id TEXT NOT NULL DEFAULT '',
  state_revision INTEGER NOT NULL DEFAULT 1 CHECK(state_revision >= 1),
  last_command_id TEXT NOT NULL DEFAULT '',
  source_device_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(owner_user_id,user_agent_instance_id),
  FOREIGN KEY(owner_user_id,user_agent_instance_id) REFERENCES cloud_user_agent_instances_v3(user_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cloud_agent_context_states_updated
  ON cloud_agent_context_states(owner_user_id,updated_at,user_agent_instance_id);
CREATE TABLE IF NOT EXISTS cloud_chat_context_states (
  id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,session_id TEXT NOT NULL,context_space_id TEXT NOT NULL DEFAULT '',
  context_epoch INTEGER NOT NULL DEFAULT 1,reset_after_message_id TEXT NOT NULL DEFAULT '',
  reset_after_created_at TEXT NOT NULL DEFAULT '',last_execution_id TEXT NOT NULL DEFAULT '',
  last_input_tokens INTEGER NOT NULL DEFAULT 0,context_window_tokens INTEGER NOT NULL DEFAULT 0,
  provider_compaction_detected INTEGER NOT NULL DEFAULT 0,state_revision INTEGER NOT NULL DEFAULT 1,
  last_command_id TEXT NOT NULL DEFAULT '',source_device_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(owner_user_id,session_id,context_space_id),CHECK(context_epoch>=1),CHECK(state_revision>=1)
);
CREATE INDEX IF NOT EXISTS idx_cloud_chat_context_states_updated
  ON cloud_chat_context_states(owner_user_id,updated_at,id);
CREATE INDEX IF NOT EXISTS idx_cloud_chat_context_states_session
  ON cloud_chat_context_states(owner_user_id,session_id,context_space_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_one_active_general_memory
  ON cloud_memory_documents_v3(user_id,user_agent_instance_id)
  WHERE scope='general' AND lifecycle_state='active';
CREATE INDEX IF NOT EXISTS idx_cloud_user_agent_instances_family_v3
  ON cloud_user_agent_instances_v3(agent_family_id, cluster_contribution_consent, updated_at);
CREATE INDEX IF NOT EXISTS idx_cloud_memory_documents_instance_v3
  ON cloud_memory_documents_v3(user_id, user_agent_instance_id, scope, updated_at);
CREATE INDEX IF NOT EXISTS idx_cloud_memory_versions_document_v3
  ON cloud_memory_document_versions_v3(user_id, memory_document_id, version_no);

CREATE TABLE IF NOT EXISTS cloud_task_security_contexts_v5 (
  user_id TEXT NOT NULL,
  task_run_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL DEFAULT '',
  local_key_id TEXT NOT NULL,
  cloud_key_id TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  cloud_evolution_allowed INTEGER NOT NULL DEFAULT 0,
  cloud_collaboration_allowed INTEGER NOT NULL DEFAULT 0,
  local_envelope_state TEXT NOT NULL DEFAULT 'reference_only',
  cloud_envelope_state TEXT NOT NULL DEFAULT 'disabled',
  status TEXT NOT NULL DEFAULT 'active',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(user_id, task_run_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_task_security_owner_v5
  ON cloud_task_security_contexts_v5(user_id, owner_user_id, status, updated_at);

CREATE TABLE IF NOT EXISTS cloud_personal_evolution_proposals_v4 (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','partially_applied','applied','rejected','legacy_proposal_stale')),
  proposal_hash TEXT NOT NULL DEFAULT '',
  origin_device_id TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS cloud_personal_evolution_memory_operations_v4 (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  memory_document_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','rejected')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS cloud_personal_evolution_actions_v4 (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  actor_device_id TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, id),
  UNIQUE(user_id, proposal_id, target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_personal_proposals_instance_v4
  ON cloud_personal_evolution_proposals_v4(user_id, user_agent_instance_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_cloud_personal_actions_proposal_v4
  ON cloud_personal_evolution_actions_v4(user_id, proposal_id, received_at);

CREATE TABLE IF NOT EXISTS cloud_sync_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, device_id)
);

CREATE TABLE IF NOT EXISTS cloud_evolution_evidence (
  evidence_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL DEFAULT '',
  context_space_id TEXT NOT NULL DEFAULT '',
  task_id TEXT NOT NULL DEFAULT '',
  delegation_id TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  content_ciphertext TEXT NOT NULL DEFAULT '',
  content_nonce TEXT NOT NULL DEFAULT '',
  content_tag TEXT NOT NULL DEFAULT '',
  encryption_algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
  key_id TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 1.0,
  privacy_level TEXT NOT NULL DEFAULT 'owner_private',
  quarantine_reason TEXT NOT NULL DEFAULT '',
  personal_threshold_eligible INTEGER NOT NULL DEFAULT 1,
  eligibility_policy_version TEXT NOT NULL DEFAULT 'personal_threshold_v1',
  occurred_at TEXT NOT NULL DEFAULT '',
  ingested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  lineage_key TEXT NOT NULL DEFAULT '',
  validation_status TEXT NOT NULL DEFAULT 'validated',
  validation_policy_version TEXT NOT NULL DEFAULT 'legacy_backfill_v1',
  validation_json TEXT NOT NULL DEFAULT '{}',
  validated_at TEXT NOT NULL DEFAULT '',
  historical_inactive INTEGER NOT NULL DEFAULT 0,
  wrapped_data_key TEXT NOT NULL DEFAULT '',
  key_wrap_algorithm TEXT NOT NULL DEFAULT '',
  key_version INTEGER NOT NULL DEFAULT 0,
  envelope_format TEXT NOT NULL DEFAULT 'legacy_symmetric',
  UNIQUE(owner_user_id, user_agent_instance_id, source_kind, source_id, source_version_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_cloud_evolution_evidence_subject
  ON cloud_evolution_evidence(owner_user_id, user_agent_instance_id, occurred_at, evidence_id);
CREATE INDEX IF NOT EXISTS idx_cloud_evidence_validation
  ON cloud_evolution_evidence(validation_status,ingested_at,evidence_id);
CREATE INDEX IF NOT EXISTS idx_cloud_evidence_lineage
  ON cloud_evolution_evidence(owner_user_id,user_agent_instance_id,lineage_key,occurred_at,evidence_id);
CREATE INDEX IF NOT EXISTS idx_cloud_evidence_personal_threshold
  ON cloud_evolution_evidence(owner_user_id,user_agent_instance_id,personal_threshold_eligible,occurred_at,evidence_id)
  WHERE quarantine_reason='';

CREATE TABLE IF NOT EXISTS cloud_evolution_evidence_validation_jobs (
  evidence_id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'queued',attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,available_at TEXT NOT NULL DEFAULT '',claimed_by TEXT NOT NULL DEFAULT '',
  claimed_at TEXT NOT NULL DEFAULT '',lease_expires_at TEXT NOT NULL DEFAULT '',error_code TEXT NOT NULL DEFAULT '',
  error_text TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',completed_at TEXT NOT NULL DEFAULT '',
  CHECK(status IN ('queued','claimed','completed','failed_retryable','failed_terminal','quarantined')),
  FOREIGN KEY(evidence_id) REFERENCES cloud_evolution_evidence(evidence_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_evidence_validation_jobs_claim
  ON cloud_evolution_evidence_validation_jobs(status,available_at,lease_expires_at);

CREATE TABLE IF NOT EXISTS cloud_evolution_evidence_quarantine (
  id TEXT PRIMARY KEY,evidence_id TEXT NOT NULL DEFAULT '',owner_user_id TEXT NOT NULL DEFAULT '',
  user_agent_instance_id TEXT NOT NULL DEFAULT '',source_kind TEXT NOT NULL DEFAULT '',source_id TEXT NOT NULL DEFAULT '',
  source_version_id TEXT NOT NULL DEFAULT '',reason_code TEXT NOT NULL,reason_text TEXT NOT NULL DEFAULT '',
  retryable INTEGER NOT NULL DEFAULT 0,resolution_status TEXT NOT NULL DEFAULT 'pending',resolution_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',resolved_at TEXT NOT NULL DEFAULT '',
  CHECK(resolution_status IN ('pending','released','rejected','resolved'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_evidence_quarantine_subject
  ON cloud_evolution_evidence_quarantine(owner_user_id,resolution_status,created_at,id);

CREATE TABLE IF NOT EXISTS cloud_evolution_evidence_access_audits (
  id TEXT PRIMARY KEY,worker_identity TEXT NOT NULL,run_id TEXT NOT NULL DEFAULT '',evidence_id TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL,result TEXT NOT NULL,result_code TEXT NOT NULL DEFAULT '',key_id TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT '',
  CHECK(result IN ('allowed','denied','failed'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_evidence_access_audit_subject
  ON cloud_evolution_evidence_access_audits(evidence_id,created_at,id);
CREATE INDEX IF NOT EXISTS idx_cloud_evidence_access_audit_run
  ON cloud_evolution_evidence_access_audits(run_id,created_at,id);

CREATE TABLE IF NOT EXISTS cloud_evolution_evidence_usage (
  evidence_id TEXT NOT NULL,
  evolution_scope TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  run_id TEXT NOT NULL DEFAULT '',
  algorithm_version TEXT NOT NULL DEFAULT '',
  re_evaluation_basis_hash TEXT NOT NULL DEFAULT '',
  rejection_kind TEXT NOT NULL DEFAULT '',
  transition_reason TEXT NOT NULL DEFAULT '',
  reserved_at TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT NOT NULL DEFAULT '',
  terminal_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(evidence_id, evolution_scope, consumer_id),
  FOREIGN KEY(evidence_id) REFERENCES cloud_evolution_evidence(evidence_id) ON DELETE CASCADE,
  CHECK(evolution_scope IN ('personal','cluster')),
  CHECK(status IN ('available','reserved','consumed','evaluated_rejected','released')),
  CHECK(rejection_kind IN ('','gate','hr_review','regression','privacy','mixed','user_rejected','invalid_source','legacy_unknown')),
  CHECK((status='evaluated_rejected' AND rejection_kind<>'') OR (status<>'evaluated_rejected' AND rejection_kind=''))
);

CREATE INDEX IF NOT EXISTS idx_cloud_evolution_usage_consumer
  ON cloud_evolution_evidence_usage(evolution_scope, consumer_id, status, updated_at);

CREATE TABLE IF NOT EXISTS cloud_evolution_evidence_usage_events (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL,
  evolution_scope TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  from_status TEXT NOT NULL DEFAULT '',
  to_status TEXT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',
  algorithm_version TEXT NOT NULL DEFAULT '',
  rejection_kind TEXT NOT NULL DEFAULT '',
  transition_reason TEXT NOT NULL DEFAULT '',
  re_evaluation_basis_hash TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(evidence_id) REFERENCES cloud_evolution_evidence(evidence_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_evolution_usage_events_subject
  ON cloud_evolution_evidence_usage_events(evolution_scope,consumer_id,occurred_at,id);

CREATE TABLE IF NOT EXISTS cloud_evolution_runs (
  id TEXT PRIMARY KEY,
  evolution_scope TEXT NOT NULL,
  owner_user_id TEXT NOT NULL DEFAULT '',
  user_agent_instance_id TEXT NOT NULL DEFAULT '',
  agent_family_id TEXT NOT NULL,
  cohort_id TEXT NOT NULL DEFAULT '',
  consumer_id TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  trigger_kind TEXT NOT NULL DEFAULT 'scheduled',
  status TEXT NOT NULL DEFAULT 'queued',
  evidence_count INTEGER NOT NULL DEFAULT 0,
  base_agent_version_id TEXT NOT NULL DEFAULT '',
  base_personal_skill_version_id TEXT NOT NULL DEFAULT '',
  candidate_personal_skill_version_id TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT NOT NULL DEFAULT '',
  CHECK(evolution_scope IN ('personal','cluster')),
  CHECK(trigger_kind IN ('manual','scheduled')),
  CHECK(status IN ('queued','claimed','running','proposed','canary','applied','failed_retryable','failed_terminal','evaluated_rejected','rolled_back','skipped','insufficient_evidence')),
  CHECK(evidence_count >= 0),
  CHECK((evolution_scope='personal' AND owner_user_id<>'' AND user_agent_instance_id<>'' AND cohort_id='' AND consumer_id=user_agent_instance_id)
    OR (evolution_scope='cluster' AND cohort_id<>'' AND user_agent_instance_id='' AND consumer_id=cohort_id))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_evolution_active_personal_run
  ON cloud_evolution_runs(user_agent_instance_id)
  WHERE evolution_scope = 'personal' AND status IN ('queued','claimed','running','proposed','failed_retryable');

CREATE TABLE IF NOT EXISTS cloud_evolution_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  job_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TEXT NOT NULL DEFAULT '',
  claimed_by TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(run_id) REFERENCES cloud_evolution_runs(id) ON DELETE CASCADE,
  CHECK(job_kind IN ('personal_evolution','cluster_evolution','cluster_shadow','cluster_canary','market_health')),
  CHECK(status IN ('queued','claimed','running','waiting_canary','completed','failed_retryable','failed_terminal','cancelled')),
  CHECK(attempt_count >= 0 AND max_attempts >= 1)
);

CREATE INDEX IF NOT EXISTS idx_cloud_evolution_jobs_claim
  ON cloud_evolution_jobs(status, available_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS cloud_personal_evolution_schedule_states (
  user_agent_instance_id TEXT PRIMARY KEY,
  last_evaluated_at TEXT NOT NULL DEFAULT '',
  next_eligible_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_status TEXT NOT NULL DEFAULT 'never_evaluated',
  last_evidence_count INTEGER NOT NULL DEFAULT 0,
  last_run_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(last_status IN ('never_evaluated','insufficient_evidence','queued','applied','evaluated_rejected','failed_retryable','failed_terminal','legacy_proposal_stale')),
  CHECK(last_evidence_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_cloud_personal_evolution_schedule_due
  ON cloud_personal_evolution_schedule_states(next_eligible_at, user_agent_instance_id);

CREATE TABLE IF NOT EXISTS cloud_evolution_run_snapshots (
  run_id TEXT PRIMARY KEY,
  snapshot_hash TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  cohort_snapshot_json TEXT NOT NULL DEFAULT '{}',
  base_skill_ciphertext TEXT NOT NULL DEFAULT '',
  personal_overlay_ciphertext TEXT NOT NULL DEFAULT '',
  memory_manifest_ciphertext TEXT NOT NULL DEFAULT '',
  canary_cases_ciphertext TEXT NOT NULL DEFAULT '',
  canary_cases_nonce TEXT NOT NULL DEFAULT '',
  canary_cases_tag TEXT NOT NULL DEFAULT '',
  canary_cases_algorithm TEXT NOT NULL DEFAULT '',
  canary_cases_key_id TEXT NOT NULL DEFAULT '',
  shadow_cases_ciphertext TEXT NOT NULL DEFAULT '',
  shadow_cases_nonce TEXT NOT NULL DEFAULT '',
  shadow_cases_tag TEXT NOT NULL DEFAULT '',
  shadow_cases_algorithm TEXT NOT NULL DEFAULT '',
  shadow_cases_key_id TEXT NOT NULL DEFAULT '',
  encryption_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(run_id) REFERENCES cloud_evolution_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_evolution_evaluations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  evaluation_kind TEXT NOT NULL,
  case_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  regression INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(run_id, evaluation_kind, case_index),
  FOREIGN KEY(run_id) REFERENCES cloud_evolution_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_evolution_apply_journals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  previous_skill_version_id TEXT NOT NULL DEFAULT '',
  next_skill_version_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'prepared',
  error_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(run_id) REFERENCES cloud_evolution_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cloud_personal_version_health (
  personal_skill_version_id TEXT PRIMARY KEY,
  user_agent_instance_id TEXT NOT NULL,
  baseline_score REAL NOT NULL DEFAULT 0,
  baseline_failure_rate REAL NOT NULL DEFAULT 0,
  observed_task_count INTEGER NOT NULL DEFAULT 0,
  latest_score REAL NOT NULL DEFAULT 0,
  latest_failure_rate REAL NOT NULL DEFAULT 0,
  consecutive_regression_windows INTEGER NOT NULL DEFAULT 0,
  last_performance_input_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'collecting',
  evaluated_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(status IN ('collecting','healthy','regressing','rollback_required','rolled_back')),
  CHECK(observed_task_count >= 0 AND consecutive_regression_windows >= 0)
);

CREATE TABLE IF NOT EXISTS cloud_agent_performance_levels (
  user_agent_instance_id TEXT PRIMARY KEY,
  agent_family_id TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  level TEXT NOT NULL DEFAULT 'P1',
  provisional INTEGER NOT NULL DEFAULT 1,
  completed_task_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(level IN ('P1','P2','P3','P4','P5','P6','P7','P8','P9','P10')),
  CHECK(score >= 0 AND score <= 100 AND completed_task_count >= 0)
);

CREATE TABLE IF NOT EXISTS cloud_agent_cohorts (
  id TEXT PRIMARY KEY,
  cohort_key TEXT NOT NULL UNIQUE,
  identity_version TEXT NOT NULL DEFAULT 'cluster_cohort_identity_v1',
  agent_family_id TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL DEFAULT '',
  capability_tags_json TEXT NOT NULL DEFAULT '[]',
  minimum_user_count INTEGER NOT NULL DEFAULT 7,
  maximum_user_weight_share REAL NOT NULL DEFAULT 0.15,
  participation_policy_version TEXT NOT NULL DEFAULT 'cluster_active_synced_mandatory_v1',
  status TEXT NOT NULL DEFAULT 'inactive' CHECK(status IN ('active','ineligible','inactive')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(minimum_user_count=7 AND maximum_user_weight_share=0.15 AND participation_policy_version='cluster_active_synced_mandatory_v1')
);

CREATE TABLE IF NOT EXISTS cloud_market_agent_candidates (
  id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',revision_no INTEGER NOT NULL DEFAULT 0,
  diagnosis_json TEXT NOT NULL DEFAULT '{}',gate_json TEXT NOT NULL DEFAULT '{}',governance_json TEXT NOT NULL DEFAULT '[]',
  canary_started_at TEXT NOT NULL DEFAULT '',canary_deadline_at TEXT NOT NULL DEFAULT '',
  shadow_started_at TEXT NOT NULL DEFAULT '',shadow_completed_at TEXT NOT NULL DEFAULT '',released_at TEXT NOT NULL DEFAULT '',
  suspended_at TEXT NOT NULL DEFAULT '',status_reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','gated','governance_approved','shadow_passed','canary_running','canary_passed','released','gate_rejected','governance_rejected','regression_rejected','privacy_rejected','canary_rejected','rolled_back','archived')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS cloud_market_agent_versions (
  id TEXT PRIMARY KEY,
  agent_family_id TEXT NOT NULL,
  parent_version_id TEXT NOT NULL DEFAULT '',
  version_kind TEXT NOT NULL DEFAULT 'legacy_sections' CHECK(version_kind IN ('market_base','legacy_sections')),
  base_agent_version_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','released','suspended','rolled_back','rejected','archived')),
  suspended_at TEXT NOT NULL DEFAULT '',status_reason TEXT NOT NULL DEFAULT '',health_baseline_json TEXT NOT NULL DEFAULT '{}',
  sections_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS cloud_user_market_adoptions (
  user_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  market_version_id TEXT NOT NULL,
  section_id TEXT NOT NULL DEFAULT '*',
  adoption_mode TEXT NOT NULL DEFAULT 'sections' CHECK(adoption_mode IN ('full','sections')),
  status TEXT NOT NULL DEFAULT 'ignored' CHECK(status IN ('adopted','superseded','rolled_back','ignored')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id, user_agent_instance_id, market_version_id, section_id)
);

CREATE TABLE IF NOT EXISTS cloud_agent_performance_events (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  task_type_key TEXT NOT NULL DEFAULT 'general',
  event_kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'legacy_client',
  source_id TEXT NOT NULL DEFAULT '',
  source_version_id TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '',
  authority TEXT NOT NULL DEFAULT 'legacy_client',
  validation_status TEXT NOT NULL DEFAULT 'legacy',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(owner_user_id, user_agent_instance_id, task_id, event_kind, occurred_at),
  CHECK(authority IN ('cloud','legacy_client')),
  CHECK(validation_status IN ('validated','deferred','rejected','legacy'))
);
CREATE INDEX IF NOT EXISTS idx_cloud_performance_events_instance ON cloud_agent_performance_events(user_agent_instance_id, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_performance_authoritative_source
  ON cloud_agent_performance_events(owner_user_id,user_agent_instance_id,source_kind,source_id,source_version_id)
  WHERE source_id<>'' AND validation_status='validated';
CREATE INDEX IF NOT EXISTS idx_cloud_performance_authoritative_window
  ON cloud_agent_performance_events(user_agent_instance_id,authority,validation_status,occurred_at);
CREATE INDEX IF NOT EXISTS idx_cloud_performance_peer_baseline
  ON cloud_agent_performance_events(task_type_key,agent_family_id,authority,validation_status,occurred_at);

CREATE TABLE IF NOT EXISTS cloud_performance_backfill_cursors (
  cursor_key TEXT PRIMARY KEY,
  last_updated_at TEXT NOT NULL DEFAULT '',
  last_source_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(status IN ('active','completed'))
);
INSERT OR IGNORE INTO cloud_performance_backfill_cursors(cursor_key,status) VALUES('task_nodes','active');

CREATE TABLE IF NOT EXISTS cloud_agent_performance_history (
  id TEXT PRIMARY KEY,
  user_agent_instance_id TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  window_ended_at TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  score REAL NOT NULL,
  level TEXT NOT NULL,
  provisional INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_agent_instance_id, algorithm_version, input_hash),
  CHECK(level IN ('P1','P2','P3','P4','P5','P6','P7','P8','P9','P10')),
  CHECK(score >= 0 AND score <= 100)
);

CREATE TABLE IF NOT EXISTS cloud_agent_leadership_events (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL DEFAULT '',
  task_id TEXT NOT NULL DEFAULT '',
  work_scope_id TEXT NOT NULL DEFAULT '',
  assignment_id TEXT NOT NULL DEFAULT '',
  event_kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(owner_user_id, user_agent_instance_id, task_id, assignment_id, event_kind, occurred_at)
);
CREATE INDEX IF NOT EXISTS idx_cloud_leadership_events_instance
  ON cloud_agent_leadership_events(user_agent_instance_id, occurred_at);

CREATE TABLE IF NOT EXISTS cloud_agent_leadership_evaluations (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL DEFAULT '',
  algorithm_version TEXT NOT NULL,
  score REAL NOT NULL,
  evaluation_json TEXT NOT NULL DEFAULT '{}',
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_agent_instance_id, task_id, assignment_id, algorithm_version),
  CHECK(score >= 0 AND score <= 100)
);

CREATE TABLE IF NOT EXISTS cloud_agent_leadership_levels (
  user_agent_instance_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL DEFAULT '',
  score REAL NOT NULL DEFAULT 0,
  level TEXT NOT NULL DEFAULT 'L0',
  provisional INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  leadership_task_count INTEGER NOT NULL DEFAULT 0,
  state_revision INTEGER NOT NULL DEFAULT 0,
  consecutive_low_windows INTEGER NOT NULL DEFAULT 0,
  last_low_input_hash TEXT NOT NULL DEFAULT '',
  last_low_evaluated_at TEXT NOT NULL DEFAULT '',
  last_low_task_count INTEGER NOT NULL DEFAULT 0,
  level_changed_at TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(level IN ('L0','L1','L2','L3')),
  CHECK(status IN ('active','frozen','inactive')),
  CHECK(score >= 0 AND score <= 100)
);

CREATE TABLE IF NOT EXISTS cloud_agent_leadership_history (
  id TEXT PRIMARY KEY,
  user_agent_instance_id TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  score REAL NOT NULL,
  level TEXT NOT NULL,
  provisional INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_agent_instance_id, algorithm_version, input_hash),
  CHECK(level IN ('L0','L1','L2','L3')),
  CHECK(score >= 0 AND score <= 100)
);

CREATE TABLE IF NOT EXISTS cloud_leadership_promotion_actions (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_level TEXT NOT NULL DEFAULT 'L0',
  to_level TEXT NOT NULL DEFAULT 'L0',
  status TEXT NOT NULL DEFAULT 'pending',
  command_id TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  evidence_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(action IN ('trial_requested','trial_approved','promote','reject','demote','freeze','restore')),
  CHECK(from_level IN ('L0','L1','L2','L3')),
  CHECK(to_level IN ('L0','L1','L2','L3'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_leadership_action_command
  ON cloud_leadership_promotion_actions(owner_user_id, command_id) WHERE command_id <> '';

CREATE TABLE IF NOT EXISTS cloud_leadership_appeals (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  leadership_action_id TEXT NOT NULL DEFAULT '',
  appeal_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  command_id TEXT NOT NULL DEFAULT '',
  submitted_reason TEXT NOT NULL DEFAULT '',
  reviewer_user_id TEXT NOT NULL DEFAULT '',
  reviewer_reason TEXT NOT NULL DEFAULT '',
  evidence_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(appeal_kind IN ('assessment','promotion','demotion','freeze','restore')),
  CHECK(status IN ('pending','approved','rejected','withdrawn'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_leadership_appeal_command
  ON cloud_leadership_appeals(owner_user_id, command_id) WHERE command_id <> '';
CREATE INDEX IF NOT EXISTS idx_cloud_leadership_appeals_review
  ON cloud_leadership_appeals(status, created_at);

CREATE TABLE IF NOT EXISTS cloud_agent_cohort_members (
  cohort_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL,
  performance_level TEXT NOT NULL DEFAULT 'P1',
  raw_weight REAL NOT NULL DEFAULT 0,
  effective_weight REAL NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(cohort_id, user_agent_instance_id),
  CHECK(performance_level IN ('P1','P2','P3','P4','P5','P6','P7','P8','P9','P10'))
);

CREATE TABLE IF NOT EXISTS cloud_cluster_run_evidence (
  run_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  raw_weight REAL NOT NULL DEFAULT 0,
  effective_weight REAL NOT NULL DEFAULT 0,
  cohort_raw_total REAL NOT NULL DEFAULT 0,
  user_cap REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(run_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS cloud_cluster_evidence_claims (
  evidence_id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  claim_state TEXT NOT NULL CHECK(claim_state IN ('reserved','consumed')),
  claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  terminal_at TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(evidence_id) REFERENCES cloud_evolution_evidence(evidence_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_cluster_claims_consumer
  ON cloud_cluster_evidence_claims(consumer_id, claim_state, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_evolution_active_cluster_run
  ON cloud_evolution_runs(cohort_id)
  WHERE evolution_scope = 'cluster' AND status IN ('queued','claimed','running','proposed','canary');

CREATE TABLE IF NOT EXISTS cloud_market_candidate_sections (
  candidate_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL DEFAULT '{}',
  support_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(candidate_id, section_id)
);

CREATE TABLE IF NOT EXISTS cloud_market_candidate_family_sections (
  candidate_id TEXT NOT NULL,agent_family_id TEXT NOT NULL,section_id TEXT NOT NULL,title TEXT NOT NULL,
  content_hash TEXT NOT NULL,content_json TEXT NOT NULL DEFAULT '{}',support_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'canary',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(candidate_id,agent_family_id,section_id)
);

CREATE TABLE IF NOT EXISTS cloud_market_candidate_section_supports (
  candidate_id TEXT NOT NULL,agent_family_id TEXT NOT NULL,section_id TEXT NOT NULL,evidence_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,contributor_id TEXT NOT NULL,evidence_handle TEXT NOT NULL,
  support_confidence REAL NOT NULL,deterministic_pass INTEGER NOT NULL DEFAULT 0,reviewer_pass INTEGER NOT NULL DEFAULT 0,
  review_stage TEXT NOT NULL DEFAULT 'initial_gate',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(candidate_id,agent_family_id,section_id,evidence_id),
  CHECK(support_confidence>=0 AND support_confidence<=1)
);
CREATE INDEX IF NOT EXISTS idx_cloud_market_candidate_support_section
  ON cloud_market_candidate_section_supports(candidate_id,agent_family_id,section_id,contributor_id);

CREATE TABLE IF NOT EXISTS cloud_market_candidate_privacy_reviews (
  id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,agent_family_id TEXT NOT NULL DEFAULT '',review_stage TEXT NOT NULL,
  deterministic_status TEXT NOT NULL,reviewer_status TEXT NOT NULL,finding_codes_json TEXT NOT NULL DEFAULT '[]',
  review_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(candidate_id,agent_family_id,review_stage)
);
CREATE INDEX IF NOT EXISTS idx_cloud_market_candidate_privacy_review
  ON cloud_market_candidate_privacy_reviews(candidate_id,review_stage,agent_family_id);

CREATE TABLE IF NOT EXISTS cloud_market_canary_opt_ins (
  user_id TEXT NOT NULL,user_agent_instance_id TEXT NOT NULL,agent_family_id TEXT NOT NULL,policy_version TEXT NOT NULL DEFAULT 'market_canary_real_user_default_on_v2',
  status TEXT NOT NULL CHECK(status IN ('active','withdrawn')),command_id TEXT NOT NULL DEFAULT '',payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id,user_agent_instance_id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_market_canary_opt_ins_family
  ON cloud_market_canary_opt_ins(agent_family_id,status,updated_at);

CREATE TABLE IF NOT EXISTS cloud_market_canary_assignments (
  candidate_id TEXT NOT NULL,user_id TEXT NOT NULL,user_agent_instance_id TEXT NOT NULL,agent_family_id TEXT NOT NULL,
  policy_version TEXT NOT NULL DEFAULT 'market_canary_real_user_default_on_v2',status TEXT NOT NULL CHECK(status IN ('enrolled','completed','withdrawn','rejected')),
  baseline_score REAL NOT NULL DEFAULT 0,baseline_failure_rate REAL NOT NULL DEFAULT 0,started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT '',payload_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(candidate_id,user_agent_instance_id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_market_canary_assignments_instance
  ON cloud_market_canary_assignments(user_agent_instance_id,status,started_at);

CREATE TABLE IF NOT EXISTS cloud_market_canary_evaluations (
  id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL UNIQUE,policy_version TEXT NOT NULL DEFAULT 'market_canary_real_user_default_on_v2',
  status TEXT NOT NULL CHECK(status IN ('insufficient','approved','rejected')),user_count INTEGER NOT NULL DEFAULT 0,
  case_count INTEGER NOT NULL DEFAULT 0,baseline_score REAL NOT NULL DEFAULT 0,candidate_score REAL NOT NULL DEFAULT 0,
  baseline_failure_rate REAL NOT NULL DEFAULT 0,candidate_failure_rate REAL NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS cloud_market_evaluations (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  evaluation_kind TEXT NOT NULL,
  case_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed',
  regression INTEGER NOT NULL DEFAULT 0,
  privacy_violation INTEGER NOT NULL DEFAULT 0,
  role_violation INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(candidate_id, evaluation_kind, case_index)
);

CREATE TABLE IF NOT EXISTS cloud_market_version_sections (
  market_version_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL DEFAULT '{}',
  ordinal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(market_version_id, section_id)
);

CREATE TRIGGER IF NOT EXISTS trg_cloud_market_version_content_immutable
BEFORE UPDATE OF agent_family_id,parent_version_id,version_kind,base_agent_version_id,health_baseline_json,sections_json,payload_json
ON cloud_market_agent_versions WHEN OLD.status='released' BEGIN
  SELECT RAISE(ABORT,'released market version content is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_cloud_market_section_update_immutable
BEFORE UPDATE ON cloud_market_version_sections
WHEN (SELECT status FROM cloud_market_agent_versions WHERE id=OLD.market_version_id)='released' BEGIN
  SELECT RAISE(ABORT,'released market version sections are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_cloud_market_section_delete_immutable
BEFORE DELETE ON cloud_market_version_sections
WHEN (SELECT status FROM cloud_market_agent_versions WHERE id=OLD.market_version_id)='released' BEGIN
  SELECT RAISE(ABORT,'released market version sections are immutable');
END;

CREATE TABLE IF NOT EXISTS cloud_market_adoption_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  market_version_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  action TEXT NOT NULL,
  conflict_resolution TEXT NOT NULL DEFAULT 'none',
  previous_status TEXT NOT NULL DEFAULT '',
  next_status TEXT NOT NULL DEFAULT '',
  command_id TEXT NOT NULL DEFAULT '',payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_market_adoption_command
  ON cloud_market_adoption_actions(user_id,command_id,section_id) WHERE command_id<>'';

CREATE TABLE IF NOT EXISTS cloud_market_version_health (
  market_version_id TEXT PRIMARY KEY,user_count INTEGER NOT NULL DEFAULT 0,observed_task_count INTEGER NOT NULL DEFAULT 0,
  baseline_score REAL NOT NULL DEFAULT 0,latest_score REAL NOT NULL DEFAULT 0,baseline_failure_rate REAL NOT NULL DEFAULT 0,
  latest_failure_rate REAL NOT NULL DEFAULT 0,consecutive_regression_windows INTEGER NOT NULL DEFAULT 0,
  last_input_hash TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'collecting',status_reason TEXT NOT NULL DEFAULT '',
  evaluated_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(status IN ('collecting','healthy','regressing','suspended'))
);

CREATE TABLE IF NOT EXISTS cloud_effective_skill_projections (
  user_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  market_version_id TEXT NOT NULL DEFAULT '',
  adopted_sections_json TEXT NOT NULL DEFAULT '[]',
  conflicts_json TEXT NOT NULL DEFAULT '[]',
  effective_skill_hash TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id, user_agent_instance_id)
);

CREATE TABLE IF NOT EXISTS cloud_memory_access_audits (
  id TEXT PRIMARY KEY,
  requester_identity TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  memory_document_id TEXT NOT NULL DEFAULT '',
  evidence_id TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS cloud_task_runs (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  owner_user_id TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_cloud_task_runs_workspace
  ON cloud_task_runs(account_workspace_id,owner_user_id,updated_at);

CREATE TABLE IF NOT EXISTS cloud_task_nodes (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL DEFAULT '',
  user_agent_instance_id TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS cloud_task_events (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL DEFAULT '',
  task_node_id TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL DEFAULT '',
  privacy_level TEXT NOT NULL DEFAULT 'owner_private',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_cloud_task_events_source
  ON cloud_task_events(task_run_id, task_node_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cloud_task_events_updated
  ON cloud_task_events(updated_at, id);

CREATE TABLE IF NOT EXISTS cloud_communications (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS file_objects (
  sha256 TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  storage_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS file_links (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  batch_id TEXT NOT NULL DEFAULT '',
  local_path TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS release_manifests (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  manifest_json TEXT NOT NULL DEFAULT '{}',
  promoted_from TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_release_latest ON release_manifests(channel, platform, arch, created_at);
CREATE INDEX IF NOT EXISTS idx_cloud_projects_v2_id ON cloud_projects_v2(user_id, id);
CREATE INDEX IF NOT EXISTS idx_cloud_conversations_v2_project ON cloud_conversations_v2(user_id, project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_cloud_messages_v2_conversation ON cloud_messages_v2(user_id, conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cloud_transcripts_v2_conversation ON cloud_transcripts_v2(user_id, conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cloud_model_executions_v2_conversation ON cloud_model_executions_v2(user_id, conversation_id, started_at);
CREATE INDEX IF NOT EXISTS idx_cloud_model_executions_v2_agent ON cloud_model_executions_v2(user_id, agent_id, started_at);
CREATE INDEX IF NOT EXISTS idx_cloud_file_refs_v2_sha ON cloud_file_refs_v2(user_id, sha256);
CREATE INDEX IF NOT EXISTS idx_cloud_file_refs_v2_conversation ON cloud_file_refs_v2(user_id, conversation_id, message_id);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  avatar_url TEXT NOT NULL DEFAULT '',
  email_verified INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL DEFAULT 'member',
  account_status TEXT NOT NULL DEFAULT 'active',
  suspended_at TEXT NOT NULL DEFAULT '',
  suspension_reason TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(account_status IN ('active','suspended'))
);

CREATE TABLE IF NOT EXISTS cloud_upload_compliance (
  user_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL DEFAULT '',
  last_access_at TEXT NOT NULL DEFAULT '',
  last_sync_at TEXT NOT NULL DEFAULT '',
  last_effective_sync_at TEXT NOT NULL DEFAULT '',
  empty_batch_streak INTEGER NOT NULL DEFAULT 0,
  suspicious_access_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  reason TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_upload_compliance_status ON cloud_upload_compliance(status, updated_at);

CREATE TABLE IF NOT EXISTS auth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_access_tokens_user ON auth_access_tokens(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_user ON auth_refresh_tokens(user_id, expires_at);

CREATE TABLE IF NOT EXISTS auth_email_verifications (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  consumed INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_email_verifications_lookup
  ON auth_email_verifications(email, purpose, consumed, created_at);

CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_friend_requests_requester ON friend_requests(requester_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_cloud_friend_requests_recipient ON friend_requests(recipient_id, status, updated_at);

CREATE TABLE IF NOT EXISTS friendships (
  id TEXT PRIMARY KEY,
  user_a_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_a_remark TEXT NOT NULL DEFAULT '',
  user_b_remark TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_a_id, user_b_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_friendships_user_a ON friendships(user_a_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_cloud_friendships_user_b ON friendships(user_b_id, status, updated_at);

CREATE TABLE IF NOT EXISTS user_blocks (
  id TEXT PRIMARY KEY,
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS social_ubuddy_capability_profiles (
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ubuddy_agent_instance_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  profile_version TEXT NOT NULL DEFAULT 'ubuddy_capability_profile_v1',
  visibility TEXT NOT NULL,
  publication_state TEXT NOT NULL DEFAULT 'active',
  source_effective_skill_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  profile_json TEXT NOT NULL DEFAULT '{}',
  state_revision INTEGER NOT NULL DEFAULT 1,
  last_command_id TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(owner_user_id,ubuddy_agent_instance_id,profile_revision),
  CHECK(profile_revision>=1),CHECK(state_revision>=1),
  CHECK(visibility IN ('friends','organization')),
  CHECK(publication_state IN ('active','archived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_ubuddy_profile_one_active
  ON social_ubuddy_capability_profiles(owner_user_id) WHERE publication_state='active';
CREATE INDEX IF NOT EXISTS idx_social_ubuddy_profile_updated
  ON social_ubuddy_capability_profiles(owner_user_id,updated_at);

CREATE TABLE IF NOT EXISTS social_ubuddy_capability_profile_commands (
  command_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(operation_kind IN ('publish','unpublish'))
);

CREATE INDEX IF NOT EXISTS idx_social_ubuddy_profile_commands_owner
  ON social_ubuddy_capability_profile_commands(owner_user_id,created_at);

CREATE TABLE IF NOT EXISTS contact_organizations (
  id TEXT PRIMARY KEY,
  organization_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  verification_code_salt TEXT NOT NULL,
  verification_code_hash TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_contact_organizations_owner ON contact_organizations(owner_user_id, updated_at);

CREATE TABLE IF NOT EXISTS contact_organization_members (
  organization_id TEXT NOT NULL REFERENCES contact_organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_contact_organization_members_user ON contact_organization_members(user_id, updated_at);

CREATE TABLE IF NOT EXISTS contact_organization_exit_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES contact_organizations(id) ON DELETE CASCADE,
  requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_by_user_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_contact_organization_exit_requests_pending
  ON contact_organization_exit_requests(organization_id, requester_user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_cloud_contact_organization_exit_requests_org
  ON contact_organization_exit_requests(organization_id, status, created_at);

CREATE TABLE IF NOT EXISTS contact_organization_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL DEFAULT '',
  organization_name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  read_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_contact_organization_notices_user
  ON contact_organization_notices(user_id, read_at, created_at);

CREATE TABLE IF NOT EXISTS account_workspaces (
  id TEXT PRIMARY KEY,
  workspace_kind TEXT NOT NULL,
  organization_id TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_account_workspaces_organization
  ON account_workspaces(organization_id) WHERE organization_id<>'';

INSERT INTO account_workspaces(id,workspace_kind,name,status)
VALUES('workspace_personal','personal','个人空间','active')
ON CONFLICT(id) DO UPDATE SET status='active',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');

CREATE TABLE IF NOT EXISTS account_workspace_memberships (
  workspace_id TEXT NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(workspace_id,user_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_account_workspace_memberships_user
  ON account_workspace_memberships(user_id,status,updated_at);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  account_kind TEXT NOT NULL CHECK(account_kind IN ('personal','organization')),
  owner_user_id TEXT NOT NULL DEFAULT '',
  organization_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','deleted','external')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((account_kind='personal' AND owner_user_id!='' AND organization_id='')
    OR (account_kind='organization' AND organization_id!=''))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_accounts_personal_owner
  ON accounts(owner_user_id) WHERE account_kind='personal';
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_accounts_organization
  ON accounts(organization_id) WHERE account_kind='organization';

CREATE TABLE IF NOT EXISTS account_memberships_v8 (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(account_id,user_id)
);

CREATE TABLE IF NOT EXISTS account_workspace_bindings_v8 (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,
  user_id_scope TEXT NOT NULL DEFAULT '',
  binding_kind TEXT NOT NULL CHECK(binding_kind IN ('personal','organization')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(account_id,workspace_id,user_id_scope),
  UNIQUE(workspace_id,user_id_scope)
);

CREATE TRIGGER IF NOT EXISTS trg_cloud_personal_account_v8_insert AFTER INSERT ON users BEGIN
  INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
  VALUES('account_personal_'||NEW.id,'personal',NEW.id,'',NEW.display_name,'active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status='active',updated_at=excluded.updated_at;
  INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
  VALUES('account_personal_'||NEW.id,NEW.id,'owner','active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(account_id,user_id) DO UPDATE SET status='active',updated_at=excluded.updated_at;
  INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
  VALUES('account_personal_'||NEW.id,'workspace_personal',NEW.id,'personal',NEW.created_at,NEW.updated_at)
  ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_cloud_personal_account_v8_update AFTER UPDATE OF display_name,updated_at ON users BEGIN
  INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
  VALUES('account_personal_'||NEW.id,'personal',NEW.id,'',NEW.display_name,'active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status='active',updated_at=excluded.updated_at;
  INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
  VALUES('account_personal_'||NEW.id,NEW.id,'owner','active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(account_id,user_id) DO UPDATE SET role='owner',status='active',updated_at=excluded.updated_at;
  INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
  VALUES('account_personal_'||NEW.id,'workspace_personal',NEW.id,'personal',NEW.created_at,NEW.updated_at)
  ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,binding_kind='personal',updated_at=excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_cloud_personal_account_workspace_membership_insert AFTER INSERT ON users BEGIN
  INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,display_name,avatar_url,joined_at,updated_at)
  VALUES('workspace_personal',NEW.id,'owner','active',NEW.display_name,NEW.avatar_url,NEW.created_at,NEW.updated_at)
  ON CONFLICT(workspace_id,user_id) DO UPDATE SET status='active',display_name=excluded.display_name,avatar_url=excluded.avatar_url,updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_cloud_personal_account_workspace_membership_update AFTER UPDATE OF display_name,avatar_url,updated_at ON users BEGIN
  INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,display_name,avatar_url,joined_at,updated_at)
  VALUES('workspace_personal',NEW.id,'owner','active',NEW.display_name,NEW.avatar_url,NEW.created_at,NEW.updated_at)
  ON CONFLICT(workspace_id,user_id) DO UPDATE SET status='active',display_name=excluded.display_name,avatar_url=excluded.avatar_url,updated_at=excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_cloud_account_workspace_organization_insert AFTER INSERT ON contact_organizations BEGIN
  INSERT INTO account_workspaces(id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at)
  VALUES('workspace_org_'||NEW.id,'organization',NEW.id,NEW.owner_user_id,NEW.name,'active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_cloud_account_workspace_organization_update AFTER UPDATE OF owner_user_id,name,updated_at ON contact_organizations BEGIN
  INSERT INTO account_workspaces(id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at)
  VALUES('workspace_org_'||NEW.id,'organization',NEW.id,NEW.owner_user_id,NEW.name,'active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_cloud_account_workspace_membership_insert AFTER INSERT ON contact_organization_members BEGIN
  INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,joined_at,updated_at)
  VALUES('workspace_org_'||NEW.organization_id,NEW.user_id,CASE WHEN NEW.role IN ('owner','admin') THEN NEW.role ELSE 'member' END,'active',NEW.joined_at,NEW.updated_at)
  ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active',updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_cloud_account_workspace_membership_update AFTER UPDATE ON contact_organization_members BEGIN
  INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,joined_at,updated_at)
  VALUES('workspace_org_'||NEW.organization_id,NEW.user_id,CASE WHEN NEW.role IN ('owner','admin') THEN NEW.role ELSE 'member' END,'active',NEW.joined_at,NEW.updated_at)
  ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active',updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_cloud_account_workspace_membership_delete AFTER DELETE ON contact_organization_members BEGIN
  UPDATE account_workspace_memberships SET status='left',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE workspace_id='workspace_org_'||OLD.organization_id AND user_id=OLD.user_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_cloud_organization_account_v8_insert AFTER INSERT ON contact_organizations BEGIN
  INSERT INTO account_workspaces(id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at)
  VALUES('workspace_org_'||NEW.id,'organization',NEW.id,NEW.owner_user_id,NEW.name,'active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
  INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
  VALUES('account_org_'||NEW.id,'organization',NEW.owner_user_id,NEW.id,NEW.name,'active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
  INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
  VALUES('account_org_'||NEW.id,'workspace_org_'||NEW.id,'','organization',NEW.created_at,NEW.updated_at)
  ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,binding_kind='organization',updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_cloud_organization_account_v8_update AFTER UPDATE OF owner_user_id,name,updated_at ON contact_organizations BEGIN
  INSERT INTO account_workspaces(id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at)
  VALUES('workspace_org_'||NEW.id,'organization',NEW.id,NEW.owner_user_id,NEW.name,'active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
  INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
  VALUES('account_org_'||NEW.id,'organization',NEW.owner_user_id,NEW.id,NEW.name,'active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
  INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
  VALUES('account_org_'||NEW.id,'workspace_org_'||NEW.id,'','organization',NEW.created_at,NEW.updated_at)
  ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,binding_kind='organization',updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_cloud_organization_account_v8_delete AFTER DELETE ON contact_organizations BEGIN
  UPDATE accounts SET status='archived',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='account_org_'||OLD.id;
  UPDATE account_memberships_v8 SET status='removed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE account_id='account_org_'||OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_cloud_organization_account_membership_v8_insert AFTER INSERT ON contact_organization_members BEGIN
  INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
  VALUES('account_org_'||NEW.organization_id,NEW.user_id,CASE WHEN NEW.role IN ('owner','admin') THEN NEW.role ELSE 'member' END,'active',NEW.joined_at,NEW.updated_at)
  ON CONFLICT(account_id,user_id) DO UPDATE SET role=excluded.role,status='active',updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_cloud_organization_account_membership_v8_update AFTER UPDATE ON contact_organization_members BEGIN
  INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
  VALUES('account_org_'||NEW.organization_id,NEW.user_id,CASE WHEN NEW.role IN ('owner','admin') THEN NEW.role ELSE 'member' END,'active',NEW.joined_at,NEW.updated_at)
  ON CONFLICT(account_id,user_id) DO UPDATE SET role=excluded.role,status='active',updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_cloud_organization_account_membership_v8_delete AFTER DELETE ON contact_organization_members BEGIN
  UPDATE account_memberships_v8 SET status='left',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE account_id='account_org_'||OLD.organization_id AND user_id=OLD.user_id;
END;

CREATE TABLE IF NOT EXISTS social_messages (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_agent_id TEXT NOT NULL DEFAULT '',
  recipient_agent_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'friend',
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unread',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cloud_social_messages_recipient ON social_messages(recipient_user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_cloud_social_messages_pair ON social_messages(sender_user_id, recipient_user_id, updated_at);

CREATE TABLE IF NOT EXISTS agent_delegations (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_request_id TEXT NOT NULL DEFAULT '',
  sender_agent_id TEXT NOT NULL DEFAULT 'secretary_agent',
  recipient_agent_id TEXT NOT NULL DEFAULT 'secretary_agent',
  title TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'assigned',
  session_id TEXT NOT NULL DEFAULT '',
  task_run_id TEXT NOT NULL DEFAULT '',
  group_id TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_delegations_recipient ON agent_delegations(recipient_user_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_cloud_agent_delegations_requester ON agent_delegations(requester_user_id, status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_delegations_client_request
  ON agent_delegations(account_workspace_id,requester_user_id,client_request_id)
  WHERE client_request_id <> '';

CREATE TABLE IF NOT EXISTS agent_delegation_workspaces (
  delegation_id TEXT NOT NULL REFERENCES agent_delegations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (delegation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_delegation_workspaces_user
  ON agent_delegation_workspaces(user_id, updated_at);

CREATE TABLE IF NOT EXISTS agent_delegation_workspace_messages (
  id TEXT PRIMARY KEY,
  delegation_id TEXT NOT NULL REFERENCES agent_delegations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'user',
  content TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  source_event_id TEXT NOT NULL DEFAULT '',
  source_group_message_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(delegation_id, user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_delegation_workspace_messages_owner
  ON agent_delegation_workspace_messages(delegation_id, user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_delegation_workspace_messages_source_event
  ON agent_delegation_workspace_messages(delegation_id, user_id, source_event_id)
  WHERE source_event_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_delegation_workspace_messages_source_group
  ON agent_delegation_workspace_messages(delegation_id, user_id, source_group_message_id)
  WHERE source_group_message_id <> '';

CREATE TABLE IF NOT EXISTS collaboration_groups (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'uBuddy 任务群',
  status TEXT NOT NULL DEFAULT 'active',
  client_request_id TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT,
  UNIQUE(account_workspace_id, owner_user_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS collaboration_group_members (
  group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  left_at TEXT,
  last_read_at TEXT,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_collaboration_members_user
  ON collaboration_group_members(user_id, status, joined_at);

CREATE TABLE IF NOT EXISTS collaboration_group_messages (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_agent_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'friend',
  content TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  source_event_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_collaboration_messages_group
  ON collaboration_group_messages(group_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_collaboration_messages_source_event
  ON collaboration_group_messages(group_id, source_event_id) WHERE source_event_id <> '';

CREATE TABLE IF NOT EXISTS task_node_result_versions (
  id TEXT PRIMARY KEY,task_run_id TEXT NOT NULL,task_node_id TEXT NOT NULL,graph_revision_id TEXT NOT NULL DEFAULT '',
  version_no INTEGER NOT NULL DEFAULT 1,result_text TEXT NOT NULL DEFAULT '',result_summary TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]',decision TEXT NOT NULL DEFAULT 'pending',decision_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),decided_at TEXT,
  UNIQUE(task_node_id,version_no)
);
CREATE INDEX IF NOT EXISTS idx_cloud_task_node_result_versions_run
  ON task_node_result_versions(task_run_id,graph_revision_id,created_at);

CREATE TABLE IF NOT EXISTS collaboration_files (
  id TEXT PRIMARY KEY,
  delegation_id TEXT NOT NULL REFERENCES agent_delegations(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES collaboration_groups(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL DEFAULT 'file',
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  data BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(delegation_id, owner_user_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_cloud_collaboration_files_group
  ON collaboration_files(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cloud_collaboration_files_delegation
  ON collaboration_files(delegation_id, created_at);

CREATE TABLE IF NOT EXISTS collaboration_group_workspaces (
  group_id TEXT PRIMARY KEY REFERENCES collaboration_groups(id) ON DELETE CASCADE,
  workspace_epoch TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS collaboration_group_workspace_files (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL DEFAULT 'file',
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  data BLOB NOT NULL DEFAULT X'',
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(group_id, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_cloud_collaboration_group_workspace_files_revision
  ON collaboration_group_workspace_files(group_id, revision);

CREATE TABLE IF NOT EXISTS agent_delegation_revisions (
  id TEXT PRIMARY KEY,
  delegation_id TEXT NOT NULL REFERENCES agent_delegations(id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL DEFAULT 1,
  action TEXT NOT NULL DEFAULT 'draft',
  content TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(delegation_id, revision_no)
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_delegation_revisions
  ON agent_delegation_revisions(delegation_id, revision_no);

CREATE TABLE IF NOT EXISTS user_presence (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'online',
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_user_presence_seen ON user_presence(user_id, last_seen_at);

CREATE TABLE IF NOT EXISTS cloud_work_scopes (
  id TEXT PRIMARY KEY,
  federation_type TEXT NOT NULL,
  federation_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  revision_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(federation_type, federation_id)
);

CREATE TABLE IF NOT EXISTS cloud_work_participants (
  work_scope_id TEXT NOT NULL REFERENCES cloud_work_scopes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_instance_id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'executor',
  collaboration_edges_json TEXT NOT NULL DEFAULT '[]',
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(work_scope_id, user_id, agent_instance_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_work_participants_scope_status
  ON cloud_work_participants(work_scope_id, status, user_id, agent_instance_id);

CREATE TABLE IF NOT EXISTS cloud_leadership_assignments (
  id TEXT PRIMARY KEY,
  work_scope_id TEXT NOT NULL REFERENCES cloud_work_scopes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_instance_id TEXT NOT NULL,
  role TEXT NOT NULL,
  leadership_level_snapshot TEXT NOT NULL DEFAULT '',
  assignment_mode TEXT NOT NULL DEFAULT 'normal' CHECK(assignment_mode IN ('normal','trial')),
  limit_snapshot_json TEXT NOT NULL DEFAULT '{}',
  permission_snapshot_json TEXT NOT NULL DEFAULT '{}',
  appointed_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_leadership_scope_agent
  ON cloud_leadership_assignments(work_scope_id, user_id, agent_instance_id, status, valid_from, valid_until);

CREATE TABLE IF NOT EXISTS cloud_work_memory_versions (
  id TEXT PRIMARY KEY,
  work_scope_id TEXT NOT NULL REFERENCES cloud_work_scopes(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_instance_id TEXT NOT NULL,
  memory_document_id TEXT NOT NULL,
  memory_document_version_id TEXT NOT NULL,
  version_no INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  source_cursor TEXT NOT NULL DEFAULT '',
  encryption_algorithm TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL DEFAULT 1,
  content_ciphertext TEXT NOT NULL,
  content_nonce TEXT NOT NULL,
  content_tag TEXT NOT NULL,
  content_aad TEXT NOT NULL DEFAULT '',
  cloud_wrap_algorithm TEXT NOT NULL,
  cloud_wrapping_key_id TEXT NOT NULL,
  cloud_wrapped_key TEXT NOT NULL,
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(owner_user_id, memory_document_version_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_work_memory_scope_target
  ON cloud_work_memory_versions(work_scope_id, agent_instance_id, published_at DESC);

CREATE TABLE IF NOT EXISTS cloud_work_memory_access_audits (
  id TEXT PRIMARY KEY,
  requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_agent_instance_id TEXT NOT NULL DEFAULT '',
  target_user_id TEXT NOT NULL DEFAULT '',
  target_agent_instance_id TEXT NOT NULL DEFAULT '',
  work_scope_id TEXT NOT NULL DEFAULT '',
  memory_document_version_id TEXT NOT NULL DEFAULT '',
  requested_reason TEXT NOT NULL DEFAULT '',
  requester_role_snapshot TEXT NOT NULL DEFAULT '',
  leadership_assignment_snapshot_json TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL,
  result_code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_work_memory_audits_scope_created
  ON cloud_work_memory_access_audits(work_scope_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cloud_evolution_key_rotation_jobs (
  evidence_id TEXT NOT NULL REFERENCES cloud_evolution_evidence(evidence_id) ON DELETE CASCADE,
  target_key_id TEXT NOT NULL,
  source_key_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','completed','failed_retryable','quarantined')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  claimed_by TEXT NOT NULL DEFAULT '',
  claimed_at TEXT,
  lease_expires_at TEXT,
  error_code TEXT NOT NULL DEFAULT '',
  error_text TEXT NOT NULL DEFAULT '',
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(evidence_id,target_key_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_evolution_key_rotation_due
  ON cloud_evolution_key_rotation_jobs(status,available_at,evidence_id);

CREATE TABLE IF NOT EXISTS request_audit (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  error_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;
