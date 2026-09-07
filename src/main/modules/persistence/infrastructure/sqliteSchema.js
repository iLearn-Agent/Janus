export const SQLITE_SCHEMA = `

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS database_meta (
  id TEXT PRIMARY KEY DEFAULT 'default',
  product_namespace TEXT NOT NULL DEFAULT 'janus',
  data_generation INTEGER NOT NULL DEFAULT 1,
  schema_epoch INTEGER NOT NULL DEFAULT 1,
  min_writer_version TEXT NOT NULL DEFAULT '',
  last_successful_app_version TEXT NOT NULL DEFAULT '',
  last_structure_fingerprint TEXT NOT NULL DEFAULT '',
  last_full_audit_at TEXT NOT NULL DEFAULT '',
  last_health_status TEXT NOT NULL DEFAULT 'unknown',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS database_maintenance_runs (
  id TEXT PRIMARY KEY,
  run_kind TEXT NOT NULL DEFAULT 'migration',
  app_version TEXT NOT NULL DEFAULT '',
  migration_id TEXT NOT NULL DEFAULT '',
  code_checksum TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'started',
  structure_fingerprint_before TEXT NOT NULL DEFAULT '',
  structure_fingerprint_after TEXT NOT NULL DEFAULT '',
  scanned_count INTEGER NOT NULL DEFAULT 0,
  repaired_count INTEGER NOT NULL DEFAULT 0,
  quarantined_count INTEGER NOT NULL DEFAULT 0,
  backup_id TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_summary TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_database_maintenance_runs_status
  ON database_maintenance_runs(status, started_at);
CREATE INDEX IF NOT EXISTS idx_database_maintenance_runs_migration
  ON database_maintenance_runs(migration_id, started_at);

CREATE TABLE IF NOT EXISTS database_quarantine_records (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '',
  agent_instance_id TEXT NOT NULL DEFAULT '',
  reason_code TEXT NOT NULL,
  resolution_status TEXT NOT NULL DEFAULT 'pending',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT NOT NULL DEFAULT '',
  UNIQUE(rule_id, source_table, source_id, reason_code)
);

CREATE INDEX IF NOT EXISTS idx_database_quarantine_pending
  ON database_quarantine_records(resolution_status, rule_id, created_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS cloud_sync_state (
  id TEXT PRIMARY KEY DEFAULT 'default',
  user_id TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  server_url TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL DEFAULT '',
  evolution_grant TEXT NOT NULL DEFAULT '',
  device_grant TEXT NOT NULL DEFAULT '',
  sync_schema_version INTEGER NOT NULL DEFAULT 5,
  sync_capabilities_json TEXT NOT NULL DEFAULT '{}',
  auto_sync INTEGER NOT NULL DEFAULT 1,
  evolution_enabled INTEGER NOT NULL DEFAULT 1,
  evolution_policy_version TEXT NOT NULL DEFAULT 'evolution_default_on_account_pause_v1',
  evolution_state_revision INTEGER NOT NULL DEFAULT 1,
  evolution_last_command_id TEXT NOT NULL DEFAULT '',
  evolution_last_checked_at TEXT NOT NULL DEFAULT '',
  evolution_last_check_error TEXT NOT NULL DEFAULT '',
  last_sync_cursor TEXT NOT NULL DEFAULT '',
  last_v6_cursor TEXT NOT NULL DEFAULT '',
  last_identity_cursor TEXT NOT NULL DEFAULT '',
  last_personal_evolution_cursor TEXT NOT NULL DEFAULT '',
  last_success_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS cloud_sync_batches (
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  cursor_from TEXT NOT NULL DEFAULT '',
  cursor_to TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  error_text TEXT NOT NULL DEFAULT '',
  response_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS cloud_file_manifest (
  local_path TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  session_id TEXT NOT NULL DEFAULT '',
  task_run_id TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  upload_status TEXT NOT NULL DEFAULT 'pending',
  uploaded_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS cloud_file_refs (
  id TEXT PRIMARY KEY,
  local_path TEXT NOT NULL DEFAULT '',
  sha256 TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  task_run_id TEXT NOT NULL DEFAULT '',
  task_node_id TEXT NOT NULL DEFAULT '',
  relation_type TEXT NOT NULL DEFAULT 'intermediate',
  source_kind TEXT NOT NULL DEFAULT '',
  original_name TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_file_sha ON cloud_file_manifest(sha256);
CREATE INDEX IF NOT EXISTS idx_cloud_file_refs_sha ON cloud_file_refs(sha256);
CREATE INDEX IF NOT EXISTS idx_cloud_file_refs_session ON cloud_file_refs(session_id, message_id);
CREATE INDEX IF NOT EXISTS idx_cloud_file_refs_project ON cloud_file_refs(project_id, session_id);
CREATE INDEX IF NOT EXISTS idx_cloud_batches_created ON cloud_sync_batches(created_at);

CREATE TABLE IF NOT EXISTS cloud_sync_v6_outbox (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  server_url TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  cursor_to TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  response_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT NOT NULL DEFAULT '',
  UNIQUE(server_url,user_id,device_id,payload_hash)
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_v6_outbox_due
  ON cloud_sync_v6_outbox(server_url,user_id,device_id,status,next_attempt_at,created_at);

CREATE TABLE IF NOT EXISTS cloud_sync_entity_revisions (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS cloud_sync_v6_deferred_changes (
  remote_user_id TEXT NOT NULL,
  local_user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  operation TEXT NOT NULL DEFAULT 'upsert',
  content_hash TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  reason_code TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_attempt_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(remote_user_id, entity_type, entity_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_v6_deferred_due
  ON cloud_sync_v6_deferred_changes(remote_user_id,status,updated_at,entity_type,entity_id);

CREATE TABLE IF NOT EXISTS account_workspaces (
  id TEXT PRIMARY KEY,
  workspace_kind TEXT NOT NULL DEFAULT 'personal',
  organization_id TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(workspace_kind IN ('personal','organization')),
  CHECK(status IN ('active','archived','deleted'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_workspaces_organization
  ON account_workspaces(organization_id) WHERE organization_id != '';

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  account_kind TEXT NOT NULL,
  owner_user_id TEXT NOT NULL DEFAULT '',
  organization_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(account_kind IN ('personal','organization')),
  CHECK(status IN ('active','archived','deleted','external')),
  CHECK((account_kind='personal' AND owner_user_id!='' AND organization_id='')
    OR (account_kind='organization' AND organization_id!=''))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_personal_owner
  ON accounts(owner_user_id) WHERE account_kind='personal';
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_organization
  ON accounts(organization_id) WHERE account_kind='organization';

CREATE TABLE IF NOT EXISTS auth_principals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  principal_kind TEXT NOT NULL DEFAULT 'local',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(user_id) REFERENCES auth_users(id) ON DELETE CASCADE,
  CHECK(principal_kind IN ('local','cloud','hybrid')),
  CHECK(status IN ('active','disabled'))
);

CREATE TABLE IF NOT EXISTS account_memberships (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(account_id,user_id),
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES auth_users(id) ON DELETE CASCADE,
  CHECK(role IN ('owner','admin','member','guest')),
  CHECK(status IN ('active','suspended','left','removed'))
);

CREATE INDEX IF NOT EXISTS idx_account_memberships_user
  ON account_memberships(user_id,status,updated_at);

CREATE TABLE IF NOT EXISTS account_workspace_bindings (
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id_scope TEXT NOT NULL DEFAULT '',
  binding_kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(account_id,workspace_id,user_id_scope),
  UNIQUE(workspace_id,user_id_scope),
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id) REFERENCES account_workspaces(id) ON DELETE CASCADE,
  CHECK(binding_kind IN ('personal','organization'))
);

CREATE TABLE IF NOT EXISTS account_workspace_memberships (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(workspace_id,user_id),
  FOREIGN KEY(workspace_id) REFERENCES account_workspaces(id) ON DELETE CASCADE,
  CHECK(role IN ('owner','admin','member','guest')),
  CHECK(status IN ('active','suspended','left','removed'))
);

CREATE INDEX IF NOT EXISTS idx_account_workspace_memberships_user
  ON account_workspace_memberships(user_id,status,updated_at);

CREATE TABLE IF NOT EXISTS account_workspace_preferences (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT 'local',
  active_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id,device_id),
  FOREIGN KEY(active_workspace_id) REFERENCES account_workspaces(id)
);

CREATE TABLE IF NOT EXISTS account_workspace_startup_preferences (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT 'local',
  startup_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id,device_id),
  FOREIGN KEY(startup_workspace_id) REFERENCES account_workspaces(id)
);

CREATE TABLE IF NOT EXISTS workspace_agent_bindings (
  workspace_id TEXT NOT NULL,
  agent_instance_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  can_receive_mentions INTEGER NOT NULL DEFAULT 0,
  can_receive_delegations INTEGER NOT NULL DEFAULT 0,
  can_read_workspace_files INTEGER NOT NULL DEFAULT 1,
  can_write_workspace_memory INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(workspace_id,agent_instance_id),
  FOREIGN KEY(workspace_id) REFERENCES account_workspaces(id) ON DELETE CASCADE,
  CHECK(visibility IN ('private','represented')),
  CHECK(status IN ('active','disabled'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_agent_bindings_owner
  ON workspace_agent_bindings(owner_user_id,workspace_id,status,updated_at);

CREATE TABLE IF NOT EXISTS account_agent_instances (
  account_id TEXT NOT NULL,
  agent_instance_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'member_private',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(account_id,agent_instance_id),
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CHECK(visibility IN ('member_private','account_shared','represented')),
  CHECK(status IN ('active','disabled','history'))
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'local_admin',
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  title TEXT NOT NULL DEFAULT 'Untitled project',
  workspace_root TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  conversation_kind TEXT NOT NULL DEFAULT 'direct',
  owner_user_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT 'Untitled',
  agent_id TEXT NOT NULL DEFAULT '',
  agent_instance_id TEXT NOT NULL DEFAULT '',
  group_id TEXT NOT NULL DEFAULT '',
  task_workspace_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  workspace_root TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(conversation_kind IN ('direct','group','task_workspace')),
  CHECK(status IN ('active','archived','deleted'))
);

CREATE TABLE IF NOT EXISTS conversation_aliases (
  alias_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  alias_kind TEXT NOT NULL DEFAULT 'legacy_session',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS conversation_account_bindings (
  conversation_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  binding_role TEXT NOT NULL DEFAULT 'participant',
  access_status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(conversation_id,account_id),
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CHECK(binding_role IN ('anchor','participant')),
  CHECK(access_status IN ('active','read_only','revoked'))
);

CREATE INDEX IF NOT EXISTS idx_conversation_account_bindings_account
  ON conversation_account_bindings(account_id,access_status,updated_at);

CREATE TABLE IF NOT EXISTS social_direct_conversations (
  id TEXT PRIMARY KEY,
  conversation_kind TEXT NOT NULL,
  anchor_account_id TEXT NOT NULL DEFAULT '',
  user_a_id TEXT NOT NULL,
  user_b_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(conversation_kind,anchor_account_id,user_a_id,user_b_id),
  CHECK(conversation_kind IN ('personal_direct','organization_direct')),
  CHECK(user_a_id<=user_b_id),
  CHECK(status IN ('active','archived','deleted'))
);

CREATE TABLE IF NOT EXISTS agent_conversation_branch_state (
  user_id TEXT NOT NULL,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  agent_instance_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  primary_session_id TEXT NOT NULL DEFAULT '',
  thread_generation INTEGER NOT NULL DEFAULT 1,
  rebuild_required INTEGER NOT NULL DEFAULT 0,
  last_injected_timeline_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id, account_workspace_id, agent_instance_id),
  CHECK(thread_generation >= 1),
  CHECK(rebuild_required IN (0,1)),
  CHECK(last_injected_timeline_sequence >= 0)
);

CREATE TABLE IF NOT EXISTS agent_conversation_thread_lineage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  agent_instance_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL DEFAULT '',
  codex_thread_id TEXT NOT NULL,
  lineage_role TEXT NOT NULL DEFAULT 'merged',
  reason TEXT NOT NULL DEFAULT 'agent_single_window_merge',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(conversation_id, codex_thread_id),
  CHECK(lineage_role IN ('winner','merged','replaced'))
);

CREATE TABLE IF NOT EXISTS agent_conversation_timeline_refs (
  sequence_no INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  agent_instance_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_conversation_id TEXT NOT NULL DEFAULT '',
  source_message_id TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(agent_instance_id, source_kind, source_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_conversation_branch_conversation
  ON agent_conversation_branch_state(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_conversation_timeline_agent_order
  ON agent_conversation_timeline_refs(user_id,agent_instance_id,occurred_at,sequence_no);
CREATE INDEX IF NOT EXISTS idx_agent_conversation_timeline_workspace_sequence
  ON agent_conversation_timeline_refs(user_id,account_workspace_id,agent_instance_id,sequence_no);

CREATE TABLE IF NOT EXISTS task_workspaces (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  delegation_id TEXT NOT NULL DEFAULT '',
  task_run_id TEXT NOT NULL DEFAULT '',
  group_id TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL DEFAULT '',
  workspace_epoch TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private',
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(delegation_id, owner_user_id),
  UNIQUE(conversation_id),
  CHECK(visibility IN ('private')),
  CHECK(status IN ('active','archived','deleted'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT 'local_admin',
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  title TEXT NOT NULL DEFAULT 'Untitled',
  department_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  agent_instance_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  workspace_root TEXT NOT NULL DEFAULT '',
  interaction_mode TEXT NOT NULL DEFAULT '',
  memory_use_enabled INTEGER NOT NULL DEFAULT 1,
  memory_generate_enabled INTEGER NOT NULL DEFAULT 0,
  goal_objective TEXT NOT NULL DEFAULT '',
  goal_status TEXT NOT NULL DEFAULT '',
  goal_tokens_used INTEGER NOT NULL DEFAULT 0,
  goal_token_budget INTEGER NOT NULL DEFAULT 0,
  goal_time_used_seconds INTEGER NOT NULL DEFAULT 0,
  codex_thread_id TEXT NOT NULL DEFAULT '',
  conversation_role TEXT NOT NULL DEFAULT 'standard',
  write_state TEXT NOT NULL DEFAULT 'writable',
  superseded_by_session_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  pinned_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  conversation_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  memory_id TEXT NOT NULL DEFAULT '',
  task_workspace_id TEXT NOT NULL DEFAULT '',
  sender_user_id TEXT NOT NULL DEFAULT '',
  source_event_id TEXT NOT NULL DEFAULT '',
  source_message_id TEXT NOT NULL DEFAULT '',
  task_run_id TEXT NOT NULL DEFAULT '',
  task_node_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  agent_instance_id TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL DEFAULT '',
  context_space_id TEXT NOT NULL DEFAULT '',
  visible INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS message_attachments (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  task_workspace_id TEXT NOT NULL DEFAULT '',
  file_id TEXT NOT NULL DEFAULT '',
  relation_type TEXT NOT NULL DEFAULT 'attachment',
  name TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  local_path TEXT NOT NULL DEFAULT '',
  remote_file_id TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(message_id, relation_type, file_id, name)
);

CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_memory_created ON messages(conversation_id, memory_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_messages_task_workspace_created ON messages(task_workspace_id, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_source_event
  ON messages(conversation_id, source_event_id) WHERE source_event_id != '';
CREATE INDEX IF NOT EXISTS idx_messages_agent_created ON messages(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_agent_instance_context_created ON messages(agent_instance_id, context_space_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_context_created ON messages(context_space_id, created_at);
CREATE INDEX IF NOT EXISTS idx_projects_account_workspace ON projects(account_workspace_id,user_id,status,updated_at);
CREATE INDEX IF NOT EXISTS idx_sessions_account_workspace ON sessions(account_workspace_id,user_id,status,updated_at);
CREATE INDEX IF NOT EXISTS idx_messages_account_workspace ON messages(account_workspace_id,session_id,created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_workspace_updated ON conversations(account_workspace_id,status,updated_at);
CREATE INDEX IF NOT EXISTS idx_conversations_owner_updated ON conversations(owner_user_id,status,updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_group ON conversations(group_id)
  WHERE group_id != '' AND conversation_kind = 'group';
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_task_workspace ON conversations(task_workspace_id) WHERE task_workspace_id != '';
CREATE INDEX IF NOT EXISTS idx_sessions_conversation ON sessions(conversation_id) WHERE conversation_id != '';
CREATE INDEX IF NOT EXISTS idx_task_workspaces_owner ON task_workspaces(owner_user_id,status,updated_at);
CREATE INDEX IF NOT EXISTS idx_message_attachments_conversation ON message_attachments(conversation_id,message_id,created_at);
CREATE INDEX IF NOT EXISTS idx_message_attachments_task_workspace ON message_attachments(task_workspace_id,created_at);

CREATE TABLE IF NOT EXISTS model_executions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT '',
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  project_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  request_message_id TEXT NOT NULL DEFAULT '',
  response_message_id TEXT NOT NULL DEFAULT '',
  task_run_id TEXT NOT NULL DEFAULT '',
  task_node_id TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  agent_instance_id TEXT NOT NULL DEFAULT '',
  agent_version_id TEXT NOT NULL DEFAULT '',
  personal_skill_version_id TEXT NOT NULL DEFAULT '',
  agent_role TEXT NOT NULL DEFAULT 'agent',
  execution_kind TEXT NOT NULL DEFAULT 'chat',
  provider_id TEXT NOT NULL DEFAULT '',
  requested_model TEXT NOT NULL DEFAULT '',
  effective_model TEXT NOT NULL DEFAULT '',
  reasoning_effort TEXT NOT NULL DEFAULT '',
  model_source TEXT NOT NULL DEFAULT 'config_default',
  codex_thread_id TEXT NOT NULL DEFAULT '',
  codex_turn_id TEXT NOT NULL DEFAULT '',
  skill_hash TEXT NOT NULL DEFAULT '',
  memory_hash TEXT NOT NULL DEFAULT '',
  memory_manifest_hash TEXT NOT NULL DEFAULT '',
  organization_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  error_text TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_model_executions_conversation ON model_executions(conversation_id, started_at);
CREATE INDEX IF NOT EXISTS idx_model_executions_agent ON model_executions(agent_id, started_at);
CREATE INDEX IF NOT EXISTS idx_model_executions_task ON model_executions(task_run_id, task_node_id);

CREATE TABLE IF NOT EXISTS managed_provider_usage_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL DEFAULT '',
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  provider_scope_id TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT 'local',
  execution_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  thread_id TEXT NOT NULL DEFAULT '',
  turn_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  agent_instance_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  reasoning_effort TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  raw_total_tokens INTEGER NOT NULL DEFAULT 0,
  charged_tokens INTEGER NOT NULL DEFAULT 0,
  usage_source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'completed',
  private_assistant INTEGER NOT NULL DEFAULT 0,
  quota_day TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_managed_provider_usage_daily
  ON managed_provider_usage_events(user_id,provider_scope_id,quota_day,occurred_at);
CREATE INDEX IF NOT EXISTS idx_managed_provider_usage_execution
  ON managed_provider_usage_events(execution_id,thread_id,turn_id);
CREATE INDEX IF NOT EXISTS idx_managed_provider_usage_private
  ON managed_provider_usage_events(user_id,private_assistant,occurred_at);

CREATE TABLE IF NOT EXISTS work_digest_jobs (
  id TEXT PRIMARY KEY,delegation_id TEXT NOT NULL UNIQUE,owner_user_id TEXT NOT NULL,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',status TEXT NOT NULL DEFAULT 'collecting',
  spec_json TEXT NOT NULL DEFAULT '{}',coverage_json TEXT NOT NULL DEFAULT '{}',expires_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,published_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_work_digest_jobs_due ON work_digest_jobs(owner_user_id,status,expires_at);
CREATE TABLE IF NOT EXISTS work_digest_versions (
  id TEXT PRIMARY KEY,job_id TEXT NOT NULL,revision_no INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'draft',
  body TEXT NOT NULL DEFAULT '',evidence_hash TEXT NOT NULL DEFAULT '',coverage_json TEXT NOT NULL DEFAULT '{}',
  source_kind TEXT NOT NULL DEFAULT 'codex',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,published_at TEXT NOT NULL DEFAULT '',
  UNIQUE(job_id,revision_no),FOREIGN KEY(job_id) REFERENCES work_digest_jobs(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS work_digest_evidence_refs (
  id TEXT PRIMARY KEY,version_id TEXT NOT NULL,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,
  source_revision TEXT NOT NULL DEFAULT '',included INTEGER NOT NULL DEFAULT 1,position INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,
  UNIQUE(version_id,source_kind,source_id,source_revision),
  FOREIGN KEY(version_id) REFERENCES work_digest_versions(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS managed_provider_thread_cursors (
  user_id TEXT NOT NULL,
  provider_scope_id TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT 'local',
  thread_id TEXT NOT NULL,
  last_total_tokens INTEGER NOT NULL DEFAULT 0,
  last_turn_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id,provider_scope_id,device_id,thread_id)
);

CREATE TABLE IF NOT EXISTS follower_workspace_state (
  owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,authorization_epoch INTEGER NOT NULL DEFAULT 1,
  disclosure_confirmed INTEGER NOT NULL DEFAULT 1,disclosure_version TEXT NOT NULL DEFAULT 'follower_default_work_sources_v1',
  provider_snapshot_json TEXT NOT NULL DEFAULT '{}',preferences_json TEXT NOT NULL DEFAULT '{}',
  preference_revision INTEGER NOT NULL DEFAULT 1,preference_hash TEXT NOT NULL DEFAULT '',
  report_sync_enabled INTEGER NOT NULL DEFAULT 1,evolution_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_user_id,account_workspace_id),CHECK(authorization_epoch>=1),CHECK(preference_revision>=1)
);
CREATE TABLE IF NOT EXISTS follower_access_grants (
  id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,category TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,scope_version INTEGER NOT NULL DEFAULT 1,granted_at TEXT NOT NULL DEFAULT '',
  revoked_at TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id,account_workspace_id,category),CHECK(enabled IN (0,1)),CHECK(scope_version>=1)
);
CREATE TABLE IF NOT EXISTS follower_access_events (
  id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,run_id TEXT NOT NULL DEFAULT '',
  followup_id TEXT NOT NULL DEFAULT '',category TEXT NOT NULL,operation TEXT NOT NULL,outcome TEXT NOT NULL,
  source_hash TEXT NOT NULL DEFAULT '',item_count INTEGER NOT NULL DEFAULT 0,reason_code TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_follower_access_events_owner ON follower_access_events(owner_user_id,account_workspace_id,created_at);
CREATE TABLE IF NOT EXISTS follower_schedules (
  id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,kind TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL,frequency TEXT NOT NULL,days_json TEXT NOT NULL DEFAULT '[]',local_time TEXT NOT NULL,
  missed_run_policy TEXT NOT NULL DEFAULT 'coalesce_once',revision INTEGER NOT NULL DEFAULT 1,
  next_occurrence_at TEXT NOT NULL DEFAULT '',last_run_at TEXT NOT NULL DEFAULT '',last_success_window_end TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(owner_user_id,account_workspace_id,kind),CHECK(enabled IN (0,1)),CHECK(revision>=1)
);
CREATE TABLE IF NOT EXISTS follower_runs (
  id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL DEFAULT '',owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,trigger TEXT NOT NULL,client_request_id TEXT NOT NULL DEFAULT '',occurrence_key TEXT NOT NULL DEFAULT '',
  window_start TEXT NOT NULL,window_end TEXT NOT NULL,timezone TEXT NOT NULL,authorization_epoch INTEGER NOT NULL,
  grant_snapshot_json TEXT NOT NULL DEFAULT '{}',source_inventory_json TEXT NOT NULL DEFAULT '[]',coverage_json TEXT NOT NULL DEFAULT '[]',
  follower_asset_version TEXT NOT NULL,base_skill_version TEXT NOT NULL,cluster_skill_version TEXT NOT NULL DEFAULT '',
  personal_overlay_version TEXT NOT NULL DEFAULT '',effective_skill_hash TEXT NOT NULL DEFAULT '',
  preference_memory_version TEXT NOT NULL DEFAULT '',preference_memory_hash TEXT NOT NULL DEFAULT '',
  report_contract_version TEXT NOT NULL,privacy_validator_version TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempt INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT NOT NULL DEFAULT '',lease_expires_at TEXT NOT NULL DEFAULT '',lease_generation INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NOT NULL DEFAULT '',error_text TEXT NOT NULL DEFAULT '',report_id TEXT NOT NULL DEFAULT '',origin_device_id TEXT NOT NULL DEFAULT 'local',
  started_at TEXT NOT NULL DEFAULT '',completed_at TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  CHECK(authorization_epoch>=1),CHECK(attempt>=0),CHECK(lease_generation>=0)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_follower_runs_occurrence ON follower_runs(occurrence_key) WHERE occurrence_key<>'';
CREATE UNIQUE INDEX IF NOT EXISTS idx_follower_runs_manual_request ON follower_runs(owner_user_id,account_workspace_id,kind,client_request_id) WHERE client_request_id<>'';
CREATE INDEX IF NOT EXISTS idx_follower_runs_due ON follower_runs(status,lease_expires_at,created_at);
CREATE TABLE IF NOT EXISTS follower_reports (
  id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,kind TEXT NOT NULL,
  window_start TEXT NOT NULL,window_end TEXT NOT NULL,timezone TEXT NOT NULL,report_json TEXT NOT NULL DEFAULT '{}',
  rendered_body TEXT NOT NULL DEFAULT '',sync_body TEXT NOT NULL DEFAULT '',privacy_state TEXT NOT NULL DEFAULT 'pending',
  privacy_validator_version TEXT NOT NULL,validated_content_hash TEXT NOT NULL DEFAULT '',redaction_count INTEGER NOT NULL DEFAULT 0,
  validation_errors_json TEXT NOT NULL DEFAULT '[]',read_at TEXT NOT NULL DEFAULT '',deleted_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(run_id) REFERENCES follower_runs(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_follower_reports_inbox ON follower_reports(owner_user_id,account_workspace_id,deleted_at,read_at,created_at);
CREATE TABLE IF NOT EXISTS follower_report_sources (
  report_id TEXT NOT NULL,ref_id TEXT NOT NULL DEFAULT '',source_kind TEXT NOT NULL,source_id TEXT NOT NULL,source_version TEXT NOT NULL,content_hash TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL DEFAULT '',observed_at TEXT NOT NULL,local_reference_json TEXT NOT NULL DEFAULT '{}',availability_state TEXT NOT NULL DEFAULT 'available',
  PRIMARY KEY(report_id,source_kind,source_id,source_version),FOREIGN KEY(report_id) REFERENCES follower_reports(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_follower_report_source_ref ON follower_report_sources(report_id,ref_id) WHERE ref_id<>'';
CREATE TABLE IF NOT EXISTS follower_quarantine_events (
  id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,entity_kind TEXT NOT NULL,
  identity_key TEXT NOT NULL,reason_code TEXT NOT NULL,expected_hash TEXT NOT NULL DEFAULT '',observed_hash TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_follower_quarantine_owner ON follower_quarantine_events(owner_user_id,account_workspace_id,created_at);
CREATE TABLE IF NOT EXISTS follower_followup_threads (
  id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,report_id TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL,deleted_at TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  FOREIGN KEY(report_id) REFERENCES follower_reports(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS follower_followup_messages (
  id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,source_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,FOREIGN KEY(thread_id) REFERENCES follower_followup_threads(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS follower_sync_outbox (
  id TEXT PRIMARY KEY,report_id TEXT NOT NULL,operation TEXT NOT NULL,projection_session_id TEXT NOT NULL DEFAULT '',
  projection_message_id TEXT NOT NULL DEFAULT '',validated_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,lease_owner TEXT NOT NULL DEFAULT '',lease_expires_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT NOT NULL DEFAULT '',
  UNIQUE(report_id,operation,validated_hash),FOREIGN KEY(report_id) REFERENCES follower_reports(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS follower_preference_signals (
  id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,
  source_version TEXT NOT NULL DEFAULT '',signal_kind TEXT NOT NULL,normalized_json TEXT NOT NULL DEFAULT '{}',signal_hash TEXT NOT NULL,
  lineage_key TEXT NOT NULL,explicit INTEGER NOT NULL DEFAULT 0,confidence REAL NOT NULL DEFAULT 1,
  personal_eligible INTEGER NOT NULL DEFAULT 0,cluster_eligible INTEGER NOT NULL DEFAULT 0,validation_state TEXT NOT NULL DEFAULT 'pending',
  evolution_outbox_id TEXT NOT NULL DEFAULT '',evidence_id TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id,account_workspace_id,lineage_key,signal_hash)
);
CREATE TABLE IF NOT EXISTS follower_evolution_bindings (
  owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,remote_user_id TEXT NOT NULL DEFAULT '',
  canonical_service_instance_id TEXT NOT NULL DEFAULT '',subject_kind TEXT NOT NULL DEFAULT 'system_service',
  state TEXT NOT NULL DEFAULT 'enable_pending',state_revision INTEGER NOT NULL DEFAULT 1,report_sync_enabled INTEGER NOT NULL DEFAULT 1,
  evolution_enabled INTEGER NOT NULL DEFAULT 0,personal_overlay_version TEXT NOT NULL DEFAULT '',personal_overlay_text TEXT NOT NULL DEFAULT '',
  personal_overlay_hash TEXT NOT NULL DEFAULT '',preference_memory_version TEXT NOT NULL DEFAULT '',
  preference_memory_json TEXT NOT NULL DEFAULT '{}',preference_memory_hash TEXT NOT NULL DEFAULT '',
  cluster_bundle_id TEXT NOT NULL DEFAULT '',cluster_skill_version TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_user_id,account_workspace_id),CHECK(subject_kind='system_service'),CHECK(state_revision>=1),
  CHECK(report_sync_enabled IN (0,1)),CHECK(evolution_enabled IN (0,1))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_follower_evolution_binding_remote
  ON follower_evolution_bindings(canonical_service_instance_id) WHERE canonical_service_instance_id<>'';
CREATE TABLE IF NOT EXISTS follower_report_projections (
  owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,projection_id TEXT NOT NULL,origin_device_id TEXT NOT NULL DEFAULT '',
  report_kind TEXT NOT NULL,window_start TEXT NOT NULL DEFAULT '',window_end TEXT NOT NULL DEFAULT '',timezone TEXT NOT NULL DEFAULT '',
  projection_json TEXT NOT NULL DEFAULT '{}',sync_body TEXT NOT NULL DEFAULT '',validated_hash TEXT NOT NULL,
  privacy_validator_version TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1,read_at TEXT NOT NULL DEFAULT '',
  deleted_at TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_user_id,account_workspace_id,projection_id),CHECK(revision>=1)
);
CREATE INDEX IF NOT EXISTS idx_follower_projection_inbox
  ON follower_report_projections(owner_user_id,account_workspace_id,deleted_at,read_at,updated_at);
CREATE TABLE IF NOT EXISTS work_notification_intents (
  id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,category TEXT NOT NULL,correlation_id TEXT NOT NULL,
  episode_revision INTEGER NOT NULL DEFAULT 1,target_type TEXT NOT NULL,target_id TEXT NOT NULL,title_key TEXT NOT NULL,body_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',attempt_count INTEGER NOT NULL DEFAULT 0,lease_owner TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT NOT NULL DEFAULT '',shown_at TEXT NOT NULL DEFAULT '',suppressed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(owner_user_id,category,correlation_id,episode_revision)
);

CREATE TABLE IF NOT EXISTS auth_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  remote_id TEXT NOT NULL DEFAULT '',
  remote_bound_at TEXT NOT NULL DEFAULT '',
  auth_provider TEXT NOT NULL DEFAULT 'local_mock',
  email_verified INTEGER NOT NULL DEFAULT 0,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'member',
  password_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_remote_id_unique
  ON auth_users(remote_id) WHERE remote_id <> '';

CREATE TABLE IF NOT EXISTS profile_update_outbox (
  user_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(user_id) REFERENCES auth_users(id) ON DELETE CASCADE,
  CHECK(status IN ('pending','sending','completed','failed'))
);

CREATE INDEX IF NOT EXISTS idx_profile_update_outbox_due
  ON profile_update_outbox(status,next_attempt_at,updated_at);

CREATE TABLE IF NOT EXISTS agent_families (
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
  classification_version TEXT NOT NULL DEFAULT 'employee_recruitment_phase_a_v1',
  current_version_id TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS agent_versions (
  id TEXT PRIMARY KEY,
  agent_family_id TEXT NOT NULL,
  version_label TEXT NOT NULL DEFAULT '',
  agent_config_json TEXT NOT NULL DEFAULT '{}',
  base_skill_content TEXT NOT NULL DEFAULT '',
  base_skill_hash TEXT NOT NULL DEFAULT '',
  memory_template_content TEXT NOT NULL DEFAULT '',
  memory_template_hash TEXT NOT NULL DEFAULT '',
  source_bundle_id TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(agent_family_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_agent_versions_family_status
  ON agent_versions(agent_family_id, status, created_at);

CREATE TABLE IF NOT EXISTS user_agent_instances (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
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
  recruitment_source TEXT NOT NULL DEFAULT 'legacy',
  policy_version TEXT NOT NULL DEFAULT 'employee_recruitment_phase_a_v1',
  pending_target_state TEXT NOT NULL DEFAULT '',
  authority_state TEXT NOT NULL DEFAULT 'local_confirmed',
  last_employee_command_id TEXT NOT NULL DEFAULT '',
  sync_enabled INTEGER NOT NULL DEFAULT 1,
  personal_evolution_consent INTEGER NOT NULL DEFAULT 1,
  cluster_contribution_consent INTEGER NOT NULL DEFAULT 0,
  personal_skill_auto_activate INTEGER NOT NULL DEFAULT 0,
  family_instance_seq INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_user_agent_instances_user_status
  ON user_agent_instances(user_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_user_agent_instances_family
  ON user_agent_instances(agent_family_id, status, updated_at);
CREATE TABLE IF NOT EXISTS user_agent_recruitment_events (
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, command_id)
);

CREATE INDEX IF NOT EXISTS idx_user_agent_recruitment_events_user
  ON user_agent_recruitment_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_user_agent_recruitment_events_instance
  ON user_agent_recruitment_events(user_agent_instance_id, created_at);

CREATE TABLE IF NOT EXISTS employee_command_outbox (
  command_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  remote_user_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  agent_family_id TEXT NOT NULL DEFAULT '',
  local_agent_instance_id TEXT NOT NULL DEFAULT '',
  proposed_instance_id TEXT NOT NULL DEFAULT '',
  expected_state_revision INTEGER NOT NULL DEFAULT 0,
  previous_employment_state TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_employee_command_outbox_status
  ON employee_command_outbox(status, created_at);

CREATE TABLE IF NOT EXISTS user_agent_skill_versions (
  id TEXT PRIMARY KEY,
  user_agent_instance_id TEXT NOT NULL,
  base_agent_version_id TEXT NOT NULL DEFAULT '',
  parent_version_id TEXT NOT NULL DEFAULT '',
  overlay_text TEXT NOT NULL DEFAULT '',
  effective_skill_content TEXT NOT NULL DEFAULT '',
  effective_skill_hash TEXT NOT NULL DEFAULT '',
  compiler_version TEXT NOT NULL DEFAULT 'overlay_concat_v1',
  authority TEXT NOT NULL DEFAULT 'legacy_local',
  status TEXT NOT NULL DEFAULT 'candidate',
  source_evolution_run_id TEXT NOT NULL DEFAULT '',
  activated_at TEXT NOT NULL DEFAULT '',
  archived_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_user_agent_skill_versions_instance
  ON user_agent_skill_versions(user_agent_instance_id, status, created_at);

CREATE TABLE IF NOT EXISTS user_agent_instance_aliases (
  alias_instance_id TEXT PRIMARY KEY,
  canonical_instance_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS agent_identity_migration_quarantine (
  id TEXT PRIMARY KEY,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '',
  agent_family_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(source_table, source_id, reason)
);

CREATE TABLE IF NOT EXISTS memory_documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  user_agent_instance_id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL DEFAULT '',
  cloud_key TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'general',
  slot_no INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL DEFAULT 'memory0',
  task_run_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  relationship_id TEXT NOT NULL DEFAULT '',
  delegation_id TEXT NOT NULL DEFAULT '',
  group_id TEXT NOT NULL DEFAULT '',
  relationship_user_id TEXT NOT NULL DEFAULT '',
  context_space_id TEXT NOT NULL DEFAULT '',
  work_scope_id TEXT NOT NULL DEFAULT '',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  visibility TEXT NOT NULL DEFAULT 'agent_private',
  sync_enabled INTEGER NOT NULL DEFAULT 1,
  allow_personal_evolution INTEGER NOT NULL DEFAULT 1,
  allow_cluster_evolution INTEGER NOT NULL DEFAULT 0,
  source_conversation_cursor TEXT NOT NULL DEFAULT '',
  encryption_key_id TEXT NOT NULL DEFAULT '',
  consent_scope_json TEXT NOT NULL DEFAULT '{}',
  current_version_id TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(account_workspace_id, user_agent_instance_id, scope, slot_no, task_run_id, project_id, relationship_id)
);

CREATE TABLE IF NOT EXISTS memory_document_aliases (
  alias_document_id TEXT PRIMARY KEY,
  canonical_document_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_documents_instance_scope
  ON memory_documents(user_agent_instance_id, scope, lifecycle_state, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_documents_user
  ON memory_documents(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_documents_account_workspace
  ON memory_documents(account_workspace_id,user_id,user_agent_instance_id,scope,lifecycle_state,updated_at);

CREATE TABLE IF NOT EXISTS memory_document_versions (
  id TEXT PRIMARY KEY,
  memory_document_id TEXT NOT NULL,
  version_no INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL DEFAULT '',
  privacy_level TEXT NOT NULL DEFAULT 'private',
  review_status TEXT NOT NULL DEFAULT 'unreviewed',
  created_by TEXT NOT NULL DEFAULT '',
  origin_document_id TEXT NOT NULL DEFAULT '',
  origin_version_no INTEGER NOT NULL DEFAULT 0,
  base_version_id TEXT NOT NULL DEFAULT '',
  parent_version_id TEXT NOT NULL DEFAULT '',
  branch_id TEXT NOT NULL DEFAULT 'main',
  conflict_state TEXT NOT NULL DEFAULT 'none',
  visibility TEXT NOT NULL DEFAULT 'agent_private',
  published_at TEXT NOT NULL DEFAULT '',
  published_by_agent_instance_id TEXT NOT NULL DEFAULT '',
  source_cursor TEXT NOT NULL DEFAULT '',
  encryption_algorithm TEXT NOT NULL DEFAULT '',
  encryption_key_id TEXT NOT NULL DEFAULT '',
  encryption_key_version INTEGER NOT NULL DEFAULT 0,
  content_ciphertext TEXT NOT NULL DEFAULT '',
  content_nonce TEXT NOT NULL DEFAULT '',
  content_tag TEXT NOT NULL DEFAULT '',
  content_aad TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(memory_document_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_memory_document_versions_document
  ON memory_document_versions(memory_document_id, version_no);

CREATE TABLE IF NOT EXISTS agent_context_spaces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  user_agent_instance_id TEXT NOT NULL,
  context_kind TEXT NOT NULL,
  memory_document_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  task_run_id TEXT NOT NULL DEFAULT '',
  delegation_id TEXT NOT NULL DEFAULT '',
  group_id TEXT NOT NULL DEFAULT '',
  relationship_user_id TEXT NOT NULL DEFAULT '',
  legacy_session_id TEXT NOT NULL DEFAULT '',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(account_workspace_id, user_agent_instance_id, context_kind, memory_document_id, project_id, task_run_id, delegation_id, group_id, relationship_user_id, legacy_session_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_context_spaces_instance
  ON agent_context_spaces(user_agent_instance_id, lifecycle_state, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_context_spaces_account_workspace
  ON agent_context_spaces(account_workspace_id,user_id,user_agent_instance_id,lifecycle_state,updated_at);

CREATE TABLE IF NOT EXISTS agent_device_context_state (
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  user_agent_instance_id TEXT NOT NULL,
  primary_session_id TEXT NOT NULL DEFAULT '',
  active_context_space_id TEXT NOT NULL DEFAULT '',
  active_memory_document_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(device_id, account_workspace_id, user_agent_instance_id)
);

CREATE TABLE IF NOT EXISTS agent_context_state (
  user_id TEXT NOT NULL,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  user_agent_instance_id TEXT NOT NULL,
  primary_session_id TEXT NOT NULL DEFAULT '',
  active_context_space_id TEXT NOT NULL DEFAULT '',
  active_memory_document_id TEXT NOT NULL DEFAULT '',
  state_revision INTEGER NOT NULL DEFAULT 1,
  base_state_revision INTEGER NOT NULL DEFAULT 0,
  last_command_id TEXT NOT NULL DEFAULT '',
  source_device_id TEXT NOT NULL DEFAULT '',
  sync_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(user_id,account_workspace_id,user_agent_instance_id),
  CHECK(state_revision >= 1),
  CHECK(base_state_revision >= 0),
  CHECK(sync_status IN ('pending','synced','conflict'))
);

CREATE INDEX IF NOT EXISTS idx_agent_context_state_sync
  ON agent_context_state(user_id,account_workspace_id,sync_status,updated_at);

CREATE TABLE IF NOT EXISTS chat_context_states (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  context_space_id TEXT NOT NULL DEFAULT '',
  context_epoch INTEGER NOT NULL DEFAULT 1,
  reset_after_message_id TEXT NOT NULL DEFAULT '',
  reset_after_created_at TEXT NOT NULL DEFAULT '',
  last_execution_id TEXT NOT NULL DEFAULT '',
  last_input_tokens INTEGER NOT NULL DEFAULT 0,
  context_window_tokens INTEGER NOT NULL DEFAULT 0,
  provider_compaction_detected INTEGER NOT NULL DEFAULT 0,
  state_revision INTEGER NOT NULL DEFAULT 1,
  base_state_revision INTEGER NOT NULL DEFAULT 0,
  last_command_id TEXT NOT NULL DEFAULT '',
  source_device_id TEXT NOT NULL DEFAULT '',
  sync_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(owner_user_id,session_id,context_space_id),
  CHECK(context_epoch >= 1),
  CHECK(state_revision >= 1),
  CHECK(base_state_revision >= 0),
  CHECK(sync_status IN ('pending','synced','conflict'))
);

CREATE INDEX IF NOT EXISTS idx_chat_context_states_sync
  ON chat_context_states(owner_user_id,sync_status,updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_general_memory
  ON memory_documents(account_workspace_id,user_id,user_agent_instance_id)
  WHERE scope='general' AND lifecycle_state='active';

CREATE TABLE IF NOT EXISTS memory_sync_mappings (
  device_id TEXT NOT NULL,
  private_key TEXT NOT NULL,
  cloud_key TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  memory_document_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(device_id, private_key),
  UNIQUE(device_id, memory_document_id),
  UNIQUE(owner_user_id, user_agent_instance_id, cloud_key)
);

CREATE TABLE IF NOT EXISTS memory_access_audits (
  id TEXT PRIMARY KEY,
  requester_user_id TEXT NOT NULL DEFAULT '',
  requester_agent_instance_id TEXT NOT NULL DEFAULT '',
  target_user_id TEXT NOT NULL DEFAULT '',
  target_agent_instance_id TEXT NOT NULL DEFAULT '',
  context_space_id TEXT NOT NULL DEFAULT '',
  task_run_id TEXT NOT NULL DEFAULT '',
  memory_document_id TEXT NOT NULL DEFAULT '',
  memory_cloud_key TEXT NOT NULL DEFAULT '',
  memory_document_version_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  requested_reason TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL,
  result_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_access_audits_target
  ON memory_access_audits(target_user_id, target_agent_instance_id, created_at);

CREATE TABLE IF NOT EXISTS legacy_memory_candidates (
  id TEXT PRIMARY KEY,
  agent_family_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  template_hash TEXT NOT NULL DEFAULT '',
  source_path TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'needs_review',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(agent_family_id, content_hash)
);

CREATE TABLE IF NOT EXISTS personal_evolution_proposals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  decision TEXT NOT NULL DEFAULT 'pending',
  skill_action_status TEXT NOT NULL DEFAULT 'none',
  memory_action_status TEXT NOT NULL DEFAULT 'none',
  sync_scope TEXT NOT NULL DEFAULT 'local_only',
  origin_device_id TEXT NOT NULL DEFAULT '',
  base_agent_version_id TEXT NOT NULL DEFAULT '',
  base_personal_skill_version_id TEXT NOT NULL DEFAULT '',
  candidate_personal_skill_version_id TEXT NOT NULL DEFAULT '',
  base_effective_skill_hash TEXT NOT NULL DEFAULT '',
  base_memory_manifest_hash TEXT NOT NULL DEFAULT '',
  evidence_cursor_from TEXT NOT NULL DEFAULT '{}',
  evidence_cursor_to TEXT NOT NULL DEFAULT '{}',
  evidence_count INTEGER NOT NULL DEFAULT 0,
  distinct_context_count INTEGER NOT NULL DEFAULT 0,
  proposal_markdown TEXT NOT NULL DEFAULT '',
  proposal_hash TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  proposed_overlay_text TEXT NOT NULL DEFAULT '',
  proposed_overlay_hash TEXT NOT NULL DEFAULT '',
  diagnostics_json TEXT NOT NULL DEFAULT '{}',
  gate_json TEXT NOT NULL DEFAULT '{}',
  privacy_report_json TEXT NOT NULL DEFAULT '{}',
  evaluation_summary_json TEXT NOT NULL DEFAULT '{}',
  auto_activation_eligible INTEGER NOT NULL DEFAULT 0,
  expires_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_personal_evolution_proposals_instance
  ON personal_evolution_proposals(user_agent_instance_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_personal_evolution_proposals_user
  ON personal_evolution_proposals(user_id, updated_at);

CREATE TABLE IF NOT EXISTS personal_evolution_proposal_evidence (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_hash TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL DEFAULT '',
  context_key TEXT NOT NULL DEFAULT '',
  privacy_level TEXT NOT NULL DEFAULT 'private',
  included INTEGER NOT NULL DEFAULT 1,
  rejection_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(proposal_id, source_kind, source_id)
);

CREATE INDEX IF NOT EXISTS idx_personal_evolution_evidence_proposal
  ON personal_evolution_proposal_evidence(proposal_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS personal_evolution_memory_operations (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  memory_document_id TEXT NOT NULL,
  section_name TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  target_item_hash TEXT NOT NULL DEFAULT '',
  proposed_text TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  baseline_version_id TEXT NOT NULL DEFAULT '',
  baseline_content_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_personal_evolution_memory_ops_proposal
  ON personal_evolution_memory_operations(proposal_id, status, created_at);

CREATE TABLE IF NOT EXISTS personal_evolution_evaluations (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  case_index INTEGER NOT NULL DEFAULT 0,
  input_text TEXT NOT NULL DEFAULT '',
  expected_text TEXT NOT NULL DEFAULT '',
  baseline_output TEXT NOT NULL DEFAULT '',
  candidate_output TEXT NOT NULL DEFAULT '',
  baseline_score REAL NOT NULL DEFAULT 0.0,
  candidate_score REAL NOT NULL DEFAULT 0.0,
  regression INTEGER NOT NULL DEFAULT 0,
  judge_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(proposal_id, case_index)
);

CREATE TABLE IF NOT EXISTS personal_evolution_proposal_actions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL,
  actor_user_id TEXT NOT NULL DEFAULT '',
  actor_device_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'local',
  error_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  confirmed_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_personal_evolution_actions_target
  ON personal_evolution_proposal_actions(proposal_id, target_kind, target_id, revision);

CREATE TABLE IF NOT EXISTS personal_evolution_instance_state (
  user_agent_instance_id TEXT PRIMARY KEY,
  evidence_cursor_json TEXT NOT NULL DEFAULT '{}',
  last_run_at TEXT NOT NULL DEFAULT '',
  last_ready_at TEXT NOT NULL DEFAULT '',
  next_eligible_at TEXT NOT NULL DEFAULT '',
  running_run_id TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS evolution_evidence_upload_queue (
  evidence_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL DEFAULT '',
  lineage_key TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  uploaded_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_evolution_evidence_upload_status
  ON evolution_evidence_upload_queue(status, updated_at);

CREATE TABLE IF NOT EXISTS evolution_evidence_outbox (
  outbox_id TEXT PRIMARY KEY,
  local_user_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL DEFAULT '',
  lineage_key TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  context_space_id TEXT NOT NULL DEFAULT '',
  task_run_id TEXT NOT NULL DEFAULT '',
  delegation_id TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 1.0,
  privacy_level TEXT NOT NULL DEFAULT 'owner_private',
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT NOT NULL DEFAULT '',
  claimed_at TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT NOT NULL DEFAULT '',
  next_attempt_at TEXT NOT NULL DEFAULT '',
  defer_reason TEXT NOT NULL DEFAULT '',
  remote_evidence_id TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  uploaded_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(local_user_id,user_agent_instance_id,source_kind,source_id,source_version_id,content_hash),
  CHECK(status IN ('pending','claimed','deferred','uploaded','failed_retryable','quarantined','rejected'))
);

CREATE INDEX IF NOT EXISTS idx_evolution_evidence_outbox_status
  ON evolution_evidence_outbox(status, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_evolution_evidence_outbox_account_due
  ON evolution_evidence_outbox(local_user_id, status, next_attempt_at, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_evolution_evidence_outbox_source
  ON evolution_evidence_outbox(source_kind, source_id, source_version_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_evolution_evidence_outbox_lineage
  ON evolution_evidence_outbox(local_user_id,user_agent_instance_id,lineage_key,created_at,outbox_id);

CREATE TABLE IF NOT EXISTS evolution_evidence_cursors (
  owner_user_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  cursor_at TEXT NOT NULL DEFAULT '',
  cursor_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(owner_user_id, source_kind)
);

CREATE TABLE IF NOT EXISTS evolution_evidence_legacy_backfills (
  owner_user_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  upper_bound_at TEXT NOT NULL DEFAULT '',
  upper_bound_id TEXT NOT NULL DEFAULT '',
  cursor_at TEXT NOT NULL DEFAULT '',
  cursor_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(owner_user_id,source_kind),
  CHECK(status IN ('pending','running','completed'))
);

CREATE TABLE IF NOT EXISTS evolution_evidence_quarantine (
  id TEXT PRIMARY KEY,outbox_id TEXT NOT NULL DEFAULT '',local_user_id TEXT NOT NULL DEFAULT '',
  user_agent_instance_id TEXT NOT NULL DEFAULT '',source_kind TEXT NOT NULL DEFAULT '',source_id TEXT NOT NULL DEFAULT '',
  source_version_id TEXT NOT NULL DEFAULT '',reason_code TEXT NOT NULL,reason_text TEXT NOT NULL DEFAULT '',
  retryable INTEGER NOT NULL DEFAULT 0,resolution_status TEXT NOT NULL DEFAULT 'pending',resolution_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),resolved_at TEXT NOT NULL DEFAULT '',
  CHECK(resolution_status IN ('pending','released','rejected','resolved'))
);

CREATE INDEX IF NOT EXISTS idx_evolution_evidence_quarantine_subject
  ON evolution_evidence_quarantine(local_user_id,resolution_status,created_at,id);

CREATE TABLE IF NOT EXISTS evolution_projection_journal (
  id TEXT PRIMARY KEY,
  cloud_run_id TEXT NOT NULL DEFAULT '',
  cloud_version_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL,
  previous_local_version_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'prepared',
  server_revision INTEGER NOT NULL DEFAULT 0,
  error_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT NOT NULL DEFAULT '',
  UNIQUE(cloud_version_id, user_agent_instance_id)
);

CREATE TABLE IF NOT EXISTS cloud_stage8_projections (
  projection_key TEXT PRIMARY KEY,
  projection_kind TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS email_verifications (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'register',
  code TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_email ON email_verifications(email, purpose, consumed, created_at);
CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_friend_requests_recipient ON friend_requests(recipient_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_friend_requests_requester ON friend_requests(requester_id, status, created_at);

CREATE TABLE IF NOT EXISTS friendships (
  id TEXT PRIMARY KEY,
  user_a_id TEXT NOT NULL,
  user_b_id TEXT NOT NULL,
  user_a_remark TEXT NOT NULL DEFAULT '',
  user_b_remark TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_a_id, user_b_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_user_a ON friendships(user_a_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_user_b ON friendships(user_b_id, status);

CREATE TABLE IF NOT EXISTS social_contact_remarks (
  owner_user_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  remark TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(owner_user_id,target_user_id),
  CHECK(owner_user_id <> target_user_id)
);

CREATE INDEX IF NOT EXISTS idx_social_contact_remarks_target
  ON social_contact_remarks(target_user_id,updated_at);

CREATE TABLE IF NOT EXISTS user_blocks (
  id TEXT PRIMARY KEY,
  blocker_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id, blocked_id);

CREATE TABLE IF NOT EXISTS contact_organizations (
  id TEXT PRIMARY KEY,
  organization_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  verification_code_salt TEXT NOT NULL DEFAULT '',
  verification_code_hash TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'local',
  remote_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_contact_organizations_owner ON contact_organizations(owner_user_id, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_organizations_remote ON contact_organizations(remote_id) WHERE remote_id <> '';

CREATE TABLE IF NOT EXISTS contact_organization_members (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  display_name_override TEXT NOT NULL DEFAULT '',
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (organization_id, user_id),
  FOREIGN KEY (organization_id) REFERENCES contact_organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contact_organization_members_user ON contact_organization_members(user_id, updated_at);

CREATE TABLE IF NOT EXISTS contact_organization_exit_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL,
  requester_role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_by_user_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (organization_id) REFERENCES contact_organizations(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_organization_exit_requests_pending
  ON contact_organization_exit_requests(organization_id, requester_user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_contact_organization_exit_requests_org
  ON contact_organization_exit_requests(organization_id, status, created_at);

CREATE TABLE IF NOT EXISTS contact_organization_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  organization_id TEXT NOT NULL DEFAULT '',
  organization_name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  read_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_contact_organization_notices_user
  ON contact_organization_notices(user_id, read_at, created_at);

CREATE TABLE IF NOT EXISTS social_messages (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  conversation_id TEXT NOT NULL DEFAULT '',
  sender_user_id TEXT NOT NULL DEFAULT '',
  recipient_user_id TEXT NOT NULL,
  sender_agent_id TEXT NOT NULL DEFAULT '',
  recipient_agent_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'friend',
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unread',
  delivery_status TEXT NOT NULL DEFAULT 'local',
  remote_id TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_social_messages_recipient ON social_messages(recipient_user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_social_messages_sender ON social_messages(sender_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_social_messages_account_workspace
  ON social_messages(account_workspace_id,recipient_user_id,status,created_at);
CREATE INDEX IF NOT EXISTS idx_social_messages_conversation
  ON social_messages(conversation_id,created_at,id);

CREATE TABLE IF NOT EXISTS agent_delegations (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  requester_user_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL DEFAULT '',
  sender_agent_id TEXT NOT NULL DEFAULT 'secretary_agent',
  recipient_agent_id TEXT NOT NULL DEFAULT 'secretary_agent',
  title TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'assigned',
  session_id TEXT NOT NULL DEFAULT '',
  task_run_id TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_delegations_recipient ON agent_delegations(recipient_user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_delegations_requester ON agent_delegations(requester_user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_delegations_account_workspace
  ON agent_delegations(account_workspace_id,requester_user_id,recipient_user_id,status,updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_delegations_client_request
  ON agent_delegations(account_workspace_id,requester_user_id,client_request_id)
  WHERE client_request_id <> '';

CREATE TABLE IF NOT EXISTS agent_delegation_workspaces (
  delegation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (delegation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_delegation_workspaces_user
  ON agent_delegation_workspaces(user_id, updated_at);

CREATE TABLE IF NOT EXISTS agent_delegation_workspace_messages (
  id TEXT PRIMARY KEY,
  delegation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  content TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  source_event_id TEXT NOT NULL DEFAULT '',
  source_group_message_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(delegation_id, user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agent_delegation_workspace_messages_owner
  ON agent_delegation_workspace_messages(delegation_id, user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_delegation_workspace_messages_source_event
  ON agent_delegation_workspace_messages(delegation_id, user_id, source_event_id)
  WHERE source_event_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_delegation_workspace_messages_source_group
  ON agent_delegation_workspace_messages(delegation_id, user_id, source_group_message_id)
  WHERE source_group_message_id <> '';

CREATE TABLE IF NOT EXISTS collaboration_groups (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  owner_user_id TEXT NOT NULL,
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
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  display_name_override TEXT NOT NULL DEFAULT '',
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  left_at TEXT,
  last_read_at TEXT,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_members_user ON collaboration_group_members(user_id, status, joined_at);

CREATE TABLE IF NOT EXISTS collaboration_group_messages (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  group_id TEXT NOT NULL,
  sender_user_id TEXT NOT NULL,
  sender_agent_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'friend',
  content TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  source_event_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_collaboration_messages_group ON collaboration_group_messages(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_collaboration_groups_account_workspace
  ON collaboration_groups(account_workspace_id,status,updated_at);
CREATE INDEX IF NOT EXISTS idx_collaboration_messages_account_workspace
  ON collaboration_group_messages(account_workspace_id,group_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_messages_source_event
  ON collaboration_group_messages(group_id, source_event_id) WHERE source_event_id <> '';

CREATE TABLE IF NOT EXISTS chat_groups (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  organization_id TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '新群聊',
  scope_type TEXT NOT NULL DEFAULT 'external',
  chat_mode TEXT NOT NULL DEFAULT 'conversation',
  binding_type TEXT NOT NULL DEFAULT 'manual',
  binding_id TEXT NOT NULL DEFAULT '',
  history_visibility TEXT NOT NULL DEFAULT 'from_join',
  status TEXT NOT NULL DEFAULT 'active',
  audience_scope TEXT NOT NULL DEFAULT 'account_social',
  client_request_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  dissolved_at TEXT,
  UNIQUE(account_workspace_id, owner_user_id, client_request_id),
  CHECK(scope_type IN ('internal','external')),
  CHECK(chat_mode IN ('conversation','topic')),
  CHECK(binding_type IN ('manual','organization','department')),
  CHECK(history_visibility IN ('from_join','full')),
  CHECK(status IN ('active','dissolved')),
  CHECK(audience_scope IN ('account_social','workspace_legacy'))
);

CREATE TABLE IF NOT EXISTS chat_group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  display_name_override TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  invited_by_user_id TEXT NOT NULL DEFAULT '',
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  left_at TEXT,
  last_read_at TEXT,
  PRIMARY KEY(group_id,user_id),
  FOREIGN KEY(group_id) REFERENCES chat_groups(id) ON DELETE CASCADE,
  CHECK(role IN ('owner','admin','member')),
  CHECK(status IN ('invited','active','left','removed','declined'))
);

CREATE TABLE IF NOT EXISTS chat_group_messages (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  group_id TEXT NOT NULL,
  sender_user_id TEXT NOT NULL,
  sender_agent_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'friend',
  content TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  source_event_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(group_id) REFERENCES chat_groups(id) ON DELETE CASCADE,
  CHECK(kind IN ('friend','agent','system'))
);

CREATE TABLE IF NOT EXISTS chat_group_message_receipts (
  message_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  read_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(message_id,recipient_user_id),
  FOREIGN KEY(message_id) REFERENCES chat_group_messages(id) ON DELETE CASCADE,
  FOREIGN KEY(group_id) REFERENCES chat_groups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_group_outbox (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  operation_kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT NOT NULL DEFAULT '',
  CHECK(operation_kind IN ('create_group','send_message','update_group')),
  CHECK(status IN ('pending','sending','completed','failed'))
);

CREATE INDEX IF NOT EXISTS idx_chat_groups_workspace
  ON chat_groups(account_workspace_id,status,updated_at);
CREATE INDEX IF NOT EXISTS idx_chat_group_members_user
  ON chat_group_members(user_id,status,joined_at);
CREATE INDEX IF NOT EXISTS idx_chat_group_messages_group
  ON chat_group_messages(group_id,created_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_group_messages_source_event
  ON chat_group_messages(group_id,source_event_id) WHERE source_event_id <> '';
CREATE INDEX IF NOT EXISTS idx_chat_group_receipts_reader
  ON chat_group_message_receipts(group_id,recipient_user_id,read_at,created_at);
CREATE INDEX IF NOT EXISTS idx_chat_group_outbox_due
  ON chat_group_outbox(account_workspace_id,status,next_attempt_at,created_at);

CREATE TABLE IF NOT EXISTS social_conversation_preferences (
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  user_id TEXT NOT NULL,
  conversation_kind TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  removed_at TEXT NOT NULL DEFAULT '',
  state_revision INTEGER NOT NULL DEFAULT 1,
  base_state_revision INTEGER NOT NULL DEFAULT 0,
  last_command_id TEXT NOT NULL DEFAULT '',
  source_device_id TEXT NOT NULL DEFAULT '',
  sync_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(account_workspace_id,user_id,conversation_kind,conversation_id),
  CHECK(conversation_kind IN ('chat_group','collaboration_group')),
  CHECK(archived IN (0,1)),
  CHECK(state_revision >= 1),
  CHECK(sync_status IN ('pending','synced','conflict'))
);

CREATE TABLE IF NOT EXISTS emoji_favorites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'image',
  value TEXT NOT NULL DEFAULT '',
  filename TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  local_path TEXT NOT NULL DEFAULT '',
  remote_file_id TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, kind, sha256),
  CHECK(kind IN ('unicode','image')),
  CHECK(size_bytes >= 0)
);

CREATE INDEX IF NOT EXISTS idx_emoji_favorites_user_order ON emoji_favorites(user_id,sort_order,created_at);

CREATE TABLE IF NOT EXISTS emoji_favorite_outbox (
  id TEXT PRIMARY KEY,user_id TEXT NOT NULL,operation_kind TEXT NOT NULL,payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',attempt_count INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_emoji_favorite_outbox_pending ON emoji_favorite_outbox(user_id,status,created_at);

CREATE TABLE IF NOT EXISTS social_conversation_preference_outbox (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  user_id TEXT NOT NULL,
  conversation_kind TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  command_id TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT NOT NULL DEFAULT '',
  CHECK(conversation_kind IN ('chat_group','collaboration_group')),
  CHECK(status IN ('pending','sending','completed','failed'))
);

CREATE INDEX IF NOT EXISTS idx_social_conversation_preferences_user
  ON social_conversation_preferences(user_id,archived,updated_at);
CREATE INDEX IF NOT EXISTS idx_social_conversation_preference_outbox_due
  ON social_conversation_preference_outbox(user_id,status,next_attempt_at,created_at);

-- Inbox-only archive state for direct messages and Agent sessions.  This is
-- intentionally separate from the legacy group preference table: archiving a
-- message thread must never change the lifecycle state of a Session.
CREATE TABLE IF NOT EXISTS social_inbox_preferences (
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  user_id TEXT NOT NULL,
  conversation_kind TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  state_revision INTEGER NOT NULL DEFAULT 1,
  last_command_id TEXT NOT NULL DEFAULT '',
  source_device_id TEXT NOT NULL DEFAULT '',
  sync_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(account_workspace_id,user_id,conversation_kind,conversation_id),
  CHECK(conversation_kind IN ('social_direct','agent_session')),
  CHECK(archived IN (0,1)),
  CHECK(state_revision >= 1),
  CHECK(sync_status IN ('pending','synced','conflict'))
);
CREATE TABLE IF NOT EXISTS social_inbox_preference_outbox (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  user_id TEXT NOT NULL,
  conversation_kind TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  command_id TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT NOT NULL DEFAULT '',
  CHECK(conversation_kind IN ('social_direct','agent_session')),
  CHECK(status IN ('pending','sending','completed','failed'))
);
CREATE INDEX IF NOT EXISTS idx_social_inbox_preferences_user
  ON social_inbox_preferences(user_id,archived,updated_at);
CREATE INDEX IF NOT EXISTS idx_social_inbox_preference_outbox_due
  ON social_inbox_preference_outbox(user_id,status,next_attempt_at,created_at);

CREATE TABLE IF NOT EXISTS ubuddy_capability_profile_cache (
  viewer_user_id TEXT NOT NULL,
  server_origin_hash TEXT NOT NULL,
  owner_remote_user_id TEXT NOT NULL,
  owner_local_user_id TEXT NOT NULL DEFAULT '',
  ubuddy_agent_instance_id TEXT NOT NULL DEFAULT '',
  profile_revision INTEGER NOT NULL DEFAULT 0,
  profile_version TEXT NOT NULL DEFAULT 'ubuddy_capability_profile_v1',
  visibility TEXT NOT NULL DEFAULT 'friends',
  content_hash TEXT NOT NULL DEFAULT '',
  profile_json TEXT NOT NULL DEFAULT '{}',
  access_scope TEXT NOT NULL DEFAULT 'friends',
  fetched_at TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(viewer_user_id,server_origin_hash,owner_remote_user_id),
  CHECK(visibility IN ('friends','organization')),
  CHECK(access_scope IN ('owner','friends','organization')),
  CHECK(profile_revision >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ubuddy_capability_profile_cache_local
  ON ubuddy_capability_profile_cache(viewer_user_id,owner_local_user_id,expires_at);

CREATE TABLE IF NOT EXISTS ubuddy_capability_profile_publication_outbox (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL DEFAULT 0,
  command_id TEXT NOT NULL UNIQUE,
  operation_kind TEXT NOT NULL,
  expected_cloud_state_revision INTEGER NOT NULL DEFAULT 0,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT NOT NULL DEFAULT '',
  CHECK(operation_kind IN ('publish','unpublish')),
  CHECK(status IN ('pending','sending','completed','failed','blocked_capability')),
  CHECK(profile_revision >= 0),
  CHECK(expected_cloud_state_revision >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ubuddy_capability_profile_outbox_due
  ON ubuddy_capability_profile_publication_outbox(owner_user_id,status,next_attempt_at,created_at);

CREATE TABLE IF NOT EXISTS ubuddy_capability_profiles (
  owner_user_id TEXT NOT NULL,
  ubuddy_agent_instance_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  source_effective_skill_hash TEXT NOT NULL,
  profile_version TEXT NOT NULL DEFAULT 'ubuddy_capability_profile_v1',
  publication_state TEXT NOT NULL DEFAULT 'draft',
  generation_status TEXT NOT NULL DEFAULT 'pending',
  generation_trigger TEXT NOT NULL DEFAULT 'skill_changed',
  profile_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL DEFAULT '',
  validation_json TEXT NOT NULL DEFAULT '{}',
  capability_scope_json TEXT NOT NULL DEFAULT '{}',
  capability_scope_hash TEXT NOT NULL DEFAULT '',
  privacy_risk_json TEXT NOT NULL DEFAULT '[]',
  requires_user_confirmation INTEGER NOT NULL DEFAULT 0,
  confirmation_reason TEXT NOT NULL DEFAULT '',
  user_confirmed_at TEXT NOT NULL DEFAULT '',
  generation_error TEXT NOT NULL DEFAULT '',
  generated_at TEXT NOT NULL DEFAULT '',
  validated_at TEXT NOT NULL DEFAULT '',
  activated_at TEXT NOT NULL DEFAULT '',
  archived_at TEXT NOT NULL DEFAULT '',
  rejected_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(owner_user_id,ubuddy_agent_instance_id,profile_revision),
  UNIQUE(owner_user_id,ubuddy_agent_instance_id,source_effective_skill_hash),
  CHECK(profile_revision >= 1),
  CHECK(publication_state IN ('draft','validated','active','archived','rejected')),
  CHECK(generation_status IN ('pending','generating','completed','failed')),
  CHECK(requires_user_confirmation IN (0,1))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ubuddy_capability_profiles_one_active
  ON ubuddy_capability_profiles(owner_user_id,ubuddy_agent_instance_id)
  WHERE publication_state='active';
CREATE INDEX IF NOT EXISTS idx_ubuddy_capability_profiles_history
  ON ubuddy_capability_profiles(owner_user_id,ubuddy_agent_instance_id,profile_revision DESC);

CREATE TABLE IF NOT EXISTS collaboration_group_workspaces (
  group_id TEXT PRIMARY KEY,
  workspace_epoch TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS collaboration_group_workspace_mirrors (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL DEFAULT '',
  workspace_epoch TEXT NOT NULL DEFAULT '',
  last_synced_revision INTEGER NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'idle',
  last_error TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS collaboration_group_workspace_file_state (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  remote_file_id TEXT NOT NULL DEFAULT '',
  remote_revision INTEGER NOT NULL DEFAULT 0,
  remote_sha256 TEXT NOT NULL DEFAULT '',
  local_sha256 TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (group_id, user_id, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_group_workspace_file_state_revision
  ON collaboration_group_workspace_file_state(group_id, user_id, remote_revision);

CREATE TABLE IF NOT EXISTS agent_delegation_revisions (
  id TEXT PRIMARY KEY,
  delegation_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL DEFAULT 1,
  action TEXT NOT NULL DEFAULT 'draft',
  content TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(delegation_id, revision_no)
);

CREATE INDEX IF NOT EXISTS idx_agent_delegation_revisions ON agent_delegation_revisions(delegation_id, revision_no);

CREATE TABLE IF NOT EXISTS cloud_auth_state (
  id TEXT PRIMARY KEY DEFAULT 'default',
  server_url TEXT NOT NULL DEFAULT '',
  access_token TEXT NOT NULL DEFAULT '',
  refresh_token TEXT NOT NULL DEFAULT '',
  remote_user_id TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  last_social_cursor TEXT NOT NULL DEFAULT '',
  last_social_message_cursor TEXT NOT NULL DEFAULT '',
  last_social_message_cursors_json TEXT NOT NULL DEFAULT '{}',
  last_delegation_cursor TEXT NOT NULL DEFAULT '',
  last_presence_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL DEFAULT '',
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  department_id TEXT NOT NULL DEFAULT '',
  lead_agent_id TEXT NOT NULL DEFAULT '',
  lead_agent_instance_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  summary TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS task_security_contexts (
  task_run_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL DEFAULT '',
  local_key_id TEXT NOT NULL,
  cloud_key_id TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  cloud_evolution_allowed INTEGER NOT NULL DEFAULT 0,
  cloud_collaboration_allowed INTEGER NOT NULL DEFAULT 0,
  cloud_sync_recovery_allowed INTEGER NOT NULL DEFAULT 1,
  local_envelope_state TEXT NOT NULL DEFAULT 'reference_only',
  cloud_envelope_state TEXT NOT NULL DEFAULT 'disabled',
  local_wrap_algorithm TEXT NOT NULL DEFAULT '',
  local_wrapping_key_id TEXT NOT NULL DEFAULT '',
  local_wrapped_key TEXT NOT NULL DEFAULT '',
  local_wrap_nonce TEXT NOT NULL DEFAULT '',
  local_wrap_tag TEXT NOT NULL DEFAULT '',
  cloud_wrap_algorithm TEXT NOT NULL DEFAULT '',
  cloud_wrapping_key_id TEXT NOT NULL DEFAULT '',
  cloud_wrapped_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_task_security_owner
  ON task_security_contexts(owner_user_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_task_runs_account_workspace
  ON task_runs(account_workspace_id,owner_user_id,status,updated_at);

CREATE TABLE IF NOT EXISTS task_nodes (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  department_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  agent_instance_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  output_format TEXT NOT NULL DEFAULT '',
  estimated_minutes INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 50,
  parallel_group TEXT NOT NULL DEFAULT '',
  blocking INTEGER NOT NULL DEFAULT 0,
  notify_json TEXT NOT NULL DEFAULT '[]',
  fallback TEXT NOT NULL DEFAULT '',
  wait_reason TEXT NOT NULL DEFAULT '',
  timeout_policy TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_retry_at TEXT NOT NULL DEFAULT '',
  last_error_code TEXT NOT NULL DEFAULT '',
  retry_strategy TEXT NOT NULL DEFAULT 'automatic',
  recovery_actions_json TEXT NOT NULL DEFAULT '[]',
  result_text TEXT NOT NULL DEFAULT '',
  result_summary TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  error_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_nodes_run_status ON task_nodes(task_run_id, status, priority);

CREATE TABLE IF NOT EXISTS work_scopes (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  parent_work_scope_id TEXT NOT NULL DEFAULT '',
  revision_id TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT NOT NULL DEFAULT '',
  federation_type TEXT NOT NULL DEFAULT '',
  federation_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(scope_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_work_scopes_owner_status
  ON work_scopes(owner_user_id, status, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_scopes_federation
  ON work_scopes(federation_type, federation_id)
  WHERE federation_type != '' AND federation_id != '';

CREATE TABLE IF NOT EXISTS work_participants (
  id TEXT PRIMARY KEY,
  work_scope_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  agent_instance_id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'executor',
  collaboration_edges_json TEXT NOT NULL DEFAULT '[]',
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(work_scope_id, agent_instance_id)
);

CREATE INDEX IF NOT EXISTS idx_work_participants_scope_status
  ON work_participants(work_scope_id, status, agent_instance_id);

CREATE TABLE IF NOT EXISTS leadership_assignments (
  id TEXT PRIMARY KEY,
  work_scope_id TEXT NOT NULL,
  agent_instance_id TEXT NOT NULL,
  role TEXT NOT NULL,
  leadership_level_snapshot TEXT NOT NULL DEFAULT '',
  assignment_mode TEXT NOT NULL DEFAULT 'normal',
  limit_snapshot_json TEXT NOT NULL DEFAULT '{}',
  permission_snapshot_json TEXT NOT NULL DEFAULT '{}',
  appointed_by TEXT NOT NULL DEFAULT '',
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_leadership_assignments_scope_agent
  ON leadership_assignments(work_scope_id, agent_instance_id, status, valid_from, valid_until);

CREATE TABLE IF NOT EXISTS work_memory_access_audits (
  id TEXT PRIMARY KEY,
  requester_user_id TEXT NOT NULL DEFAULT '',
  requester_agent_instance_id TEXT NOT NULL DEFAULT '',
  target_user_id TEXT NOT NULL DEFAULT '',
  target_agent_instance_id TEXT NOT NULL DEFAULT '',
  work_scope_id TEXT NOT NULL DEFAULT '',
  memory_document_id TEXT NOT NULL DEFAULT '',
  memory_document_version_id TEXT NOT NULL DEFAULT '',
  requested_reason TEXT NOT NULL DEFAULT '',
  requester_role_snapshot TEXT NOT NULL DEFAULT '',
  leadership_assignment_snapshot_json TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL,
  result_code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_work_memory_access_audits_scope_created
  ON work_memory_access_audits(work_scope_id, created_at);

CREATE TABLE IF NOT EXISTS work_memory_publication_outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT '',
  work_scope_id TEXT NOT NULL,
  memory_document_version_id TEXT NOT NULL,
  federation_type TEXT NOT NULL CHECK (federation_type IN ('delegation','collaboration_group')),
  federation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','published','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT NOT NULL DEFAULT '',
  next_attempt_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  published_at TEXT NOT NULL DEFAULT '',
  UNIQUE(memory_document_version_id)
);

CREATE INDEX IF NOT EXISTS idx_work_memory_publication_outbox_due
  ON work_memory_publication_outbox(user_id, status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS agent_work_queue (
  sequence_no INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  agent_instance_id TEXT NOT NULL,
  work_kind TEXT NOT NULL,
  work_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  payload_json TEXT NOT NULL DEFAULT '{}',
  error_text TEXT NOT NULL DEFAULT '',
  enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(work_kind, work_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_work_queue_instance_status
  ON agent_work_queue(agent_instance_id, status, sequence_no);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_work_queue_one_running
  ON agent_work_queue(agent_instance_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_agent_work_queue_account_workspace
  ON agent_work_queue(account_workspace_id,user_id,status,sequence_no);

CREATE TABLE IF NOT EXISTS agent_work_reservations (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  owner_user_id TEXT NOT NULL DEFAULT '',
  task_run_id TEXT NOT NULL,
  agent_instance_id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT NOT NULL DEFAULT '',
  heartbeat_at TEXT NOT NULL DEFAULT '',
  reserved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  released_at TEXT NOT NULL DEFAULT '',
  release_reason TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
  CHECK(status IN ('active','released','cancelled')),
  UNIQUE(task_run_id, agent_instance_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_work_reservations_one_active
  ON agent_work_reservations(agent_instance_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_agent_work_reservations_task
  ON agent_work_reservations(task_run_id, status, reserved_at);
CREATE INDEX IF NOT EXISTS idx_agent_work_reservations_workspace
  ON agent_work_reservations(account_workspace_id, owner_user_id, status, reserved_at);

CREATE TABLE IF NOT EXISTS ubuddy_agent_wait_requests (
  id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  owner_user_id TEXT NOT NULL DEFAULT '',
  task_run_id TEXT NOT NULL,
  allocation_key TEXT NOT NULL,
  agent_family_id TEXT NOT NULL,
  department_id TEXT NOT NULL DEFAULT '',
  preferred_agent_instance_id TEXT NOT NULL DEFAULT '',
  candidate_instance_ids_json TEXT NOT NULL DEFAULT '[]',
  task_node_ids_json TEXT NOT NULL DEFAULT '[]',
  requirements_json TEXT NOT NULL DEFAULT '{}',
  binding_policy TEXT NOT NULL DEFAULT 'family',
  leader_slot INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'waiting',
  reservation_id TEXT NOT NULL DEFAULT '',
  matched_agent_instance_id TEXT NOT NULL DEFAULT '',
  wait_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  matched_at TEXT NOT NULL DEFAULT '',
  cancelled_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
  CHECK(status IN ('waiting','matched','cancelled')),
  CHECK(binding_policy IN ('exact','family')),
  CHECK(leader_slot IN (0,1)),
  UNIQUE(task_run_id, allocation_key)
);

CREATE INDEX IF NOT EXISTS idx_ubuddy_agent_wait_due
  ON ubuddy_agent_wait_requests(status, priority, created_at, task_run_id);
CREATE INDEX IF NOT EXISTS idx_ubuddy_agent_wait_task
  ON ubuddy_agent_wait_requests(task_run_id, status, allocation_key);

CREATE TABLE IF NOT EXISTS agent_delivery_receipts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  source_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  target_agent_instance_id TEXT NOT NULL,
  request_message_id TEXT NOT NULL DEFAULT '',
  target_message_id TEXT NOT NULL DEFAULT '',
  source_notification_message_id TEXT NOT NULL DEFAULT '',
  work_id TEXT NOT NULL UNIQUE,
  delivery_status TEXT NOT NULL DEFAULT 'queued',
  read_status TEXT NOT NULL DEFAULT 'read',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delivered_at TEXT NOT NULL DEFAULT '',
  read_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_agent_delivery_receipts_unread
  ON agent_delivery_receipts(user_id,target_session_id,read_status,updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_delivery_receipts_account_workspace
  ON agent_delivery_receipts(account_workspace_id,user_id,read_status,updated_at);

CREATE TABLE IF NOT EXISTS agent_delivery_events (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'progress',
  stage TEXT NOT NULL DEFAULT 'working',
  message TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(work_id, sequence_no)
);

CREATE INDEX IF NOT EXISTS idx_agent_delivery_events_work_sequence
  ON agent_delivery_events(work_id, sequence_no);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  task_node_id TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  privacy_level TEXT NOT NULL DEFAULT 'owner_private',
  summary TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_task_events_run_created ON task_events(task_run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_events_updated ON task_events(updated_at, id);

CREATE TABLE IF NOT EXISTS ubuddy_coordination_states (
  task_run_id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  owner_user_id TEXT NOT NULL DEFAULT '',
  source_session_id TEXT NOT NULL DEFAULT '',
  leader_agent_id TEXT NOT NULL DEFAULT '',
  leader_agent_instance_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'planning',
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  current_wake_event_id TEXT NOT NULL DEFAULT '',
  sleep_reason TEXT NOT NULL DEFAULT '',
  state_revision INTEGER NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  waiting_at TEXT NOT NULL DEFAULT '',
  sleeping_at TEXT NOT NULL DEFAULT '',
  awakened_at TEXT NOT NULL DEFAULT '',
  delivering_at TEXT NOT NULL DEFAULT '',
  terminal_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
  CHECK(state IN ('planning','waiting_for_agents','sleeping','awakened','delivering','completed','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_ubuddy_coordination_state
  ON ubuddy_coordination_states(state, updated_at, task_run_id);
CREATE INDEX IF NOT EXISTS idx_ubuddy_coordination_workspace
  ON ubuddy_coordination_states(account_workspace_id, owner_user_id, state, updated_at);

CREATE TABLE IF NOT EXISTS ubuddy_wake_outbox (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  coordination_generation INTEGER NOT NULL CHECK (coordination_generation >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  owner_user_id TEXT NOT NULL DEFAULT '',
  source_session_id TEXT NOT NULL DEFAULT '',
  leader_agent_id TEXT NOT NULL DEFAULT '',
  leader_agent_instance_id TEXT NOT NULL DEFAULT '',
  reason_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT NOT NULL DEFAULT '{}',
  source_task_event_id TEXT NOT NULL DEFAULT '',
  claimed_by TEXT NOT NULL DEFAULT '',
  claimed_at TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  delivery_message_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delivered_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
  CHECK(reason_code IN ('completion','recovery_required','recovery_exhausted','user_action_required','cancelled','planning_failed')),
  CHECK(status IN ('pending','claimed','failed_retryable','delivered','failed_terminal','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_ubuddy_wake_due
  ON ubuddy_wake_outbox(status, next_attempt_at, lease_expires_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ubuddy_wake_task_generation_unique
  ON ubuddy_wake_outbox(task_run_id, coordination_generation);
CREATE INDEX IF NOT EXISTS idx_ubuddy_wake_task
  ON ubuddy_wake_outbox(task_run_id, coordination_generation, status);

CREATE TABLE IF NOT EXISTS ubuddy_planning_jobs (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL UNIQUE,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  owner_user_id TEXT NOT NULL DEFAULT '',
  source_session_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  claimed_by TEXT NOT NULL DEFAULT '',
  claimed_at TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT NOT NULL DEFAULT '',
  next_attempt_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT NOT NULL DEFAULT '',
  cancelled_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
  CHECK(status IN ('pending','claimed','retry_wait','completed','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_ubuddy_planning_jobs_due
  ON ubuddy_planning_jobs(status, next_attempt_at, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS ubuddy_dispatch_commands (
  command_id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  owner_user_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL DEFAULT '',
  source_message_id TEXT NOT NULL DEFAULT '',
  command_version INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'selection_saved',
  payload_hash TEXT NOT NULL,
  command_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 10),
  claimed_at TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT NOT NULL DEFAULT '',
  next_attempt_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT NOT NULL DEFAULT '',
  CHECK(command_version >= 3),
  CHECK(status IN ('selection_saved','dispatching','published','clarification','retry_wait','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_ubuddy_dispatch_commands_due
  ON ubuddy_dispatch_commands(status,next_attempt_at,lease_expires_at,created_at);
CREATE INDEX IF NOT EXISTS idx_ubuddy_dispatch_commands_source
  ON ubuddy_dispatch_commands(owner_user_id,source_session_id,source_message_id,created_at);

CREATE TABLE IF NOT EXISTS ubuddy_pending_dispatch_assignments (
  command_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_presence',
  delegation_id TEXT NOT NULL DEFAULT '',
  group_id TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(command_id,assignment_id),
  UNIQUE(command_id,recipient_user_id),
  CHECK(status IN ('awaiting_presence','publishing','published','cancelled','failed'))
);

CREATE INDEX IF NOT EXISTS idx_ubuddy_pending_dispatch_due
  ON ubuddy_pending_dispatch_assignments(status,updated_at,command_id);

CREATE TABLE IF NOT EXISTS task_graph_revisions (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  revision_type TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  actor_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_task_graph_revisions_run ON task_graph_revisions(task_run_id, created_at);

CREATE TABLE IF NOT EXISTS task_node_result_versions (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  task_node_id TEXT NOT NULL,
  graph_revision_id TEXT NOT NULL DEFAULT '',
  version_no INTEGER NOT NULL DEFAULT 1,
  result_text TEXT NOT NULL DEFAULT '',
  result_summary TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  decision TEXT NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','adopted','superseded','rejected')),
  decision_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT,
  UNIQUE(task_node_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_task_node_result_versions_run
  ON task_node_result_versions(task_run_id, graph_revision_id, created_at);

CREATE TABLE IF NOT EXISTS task_delivery_reviews (
  task_run_id TEXT PRIMARY KEY,
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
  owner_user_id TEXT NOT NULL DEFAULT '',
  policy_version TEXT NOT NULL DEFAULT 'delivery_review_policy_v1',
  state TEXT NOT NULL DEFAULT 'submitted',
  quality_revision_count INTEGER NOT NULL DEFAULT 0,
  quality_revision_limit INTEGER NOT NULL DEFAULT 2,
  execution_attempt_count INTEGER NOT NULL DEFAULT 0,
  latest_submission_id TEXT NOT NULL DEFAULT '',
  latest_feedback_json TEXT NOT NULL DEFAULT '{}',
  last_review_event_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  terminal_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
  CHECK(state IN ('submitted','verifying','revision_requested','reworking','accepted','action_required','revision_exhausted','failed')),
  CHECK(quality_revision_count >= 0),
  CHECK(quality_revision_limit BETWEEN 1 AND 20),
  CHECK(quality_revision_count <= quality_revision_limit),
  CHECK(execution_attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_task_delivery_reviews_state
  ON task_delivery_reviews(state, updated_at, task_run_id);
CREATE INDEX IF NOT EXISTS idx_task_delivery_reviews_owner
  ON task_delivery_reviews(account_workspace_id, owner_user_id, state, updated_at);

CREATE TABLE IF NOT EXISTS task_delivery_submissions (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  task_node_id TEXT NOT NULL DEFAULT '',
  result_version_id TEXT NOT NULL DEFAULT '',
  submission_key TEXT NOT NULL UNIQUE,
  submission_no INTEGER NOT NULL,
  body_snapshot TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  artifact_manifest_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
  UNIQUE(task_run_id, submission_no),
  CHECK(submission_no >= 1)
);

CREATE INDEX IF NOT EXISTS idx_task_delivery_submissions_run
  ON task_delivery_submissions(task_run_id, submission_no, created_at);

CREATE TABLE IF NOT EXISTS task_delivery_review_events (
  event_id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  submission_id TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  from_state TEXT NOT NULL DEFAULT '',
  to_state TEXT NOT NULL DEFAULT '',
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
  UNIQUE(task_run_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_task_delivery_review_events_run
  ON task_delivery_review_events(task_run_id, created_at, event_id);

CREATE TABLE IF NOT EXISTS task_delivery_review_jobs (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT NOT NULL DEFAULT '{}',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  claimed_by TEXT NOT NULL DEFAULT '',
  claimed_at TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT NOT NULL DEFAULT '',
  next_attempt_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(submission_id) REFERENCES task_delivery_submissions(id) ON DELETE CASCADE,
  UNIQUE(submission_id),
  CHECK(status IN ('pending','claimed','retry_wait','completed','action_required','cancelled')),
  CHECK(attempt_count >= 0),
  CHECK(max_attempts BETWEEN 1 AND 10)
);

CREATE INDEX IF NOT EXISTS idx_task_delivery_review_jobs_due
  ON task_delivery_review_jobs(status, next_attempt_at, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS task_retrospectives (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL UNIQUE,
  participants_json TEXT NOT NULL DEFAULT '[]',
  assignment_json TEXT NOT NULL DEFAULT '{}',
  communication_json TEXT NOT NULL DEFAULT '[]',
  wait_summary_json TEXT NOT NULL DEFAULT '[]',
  skill_findings_json TEXT NOT NULL DEFAULT '[]',
  memory_candidates_json TEXT NOT NULL DEFAULT '[]',
  failure_points_json TEXT NOT NULL DEFAULT '[]',
  final_summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  agent_instance_id TEXT NOT NULL DEFAULT '',
  memory_document_id TEXT NOT NULL DEFAULT '',
  task_run_id TEXT NOT NULL DEFAULT '',
  memory_type TEXT NOT NULL,
  content TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  confidence REAL NOT NULL DEFAULT 0.5,
  privacy_level TEXT NOT NULL DEFAULT 'public_reusable',
  source_kind TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'unreviewed',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_entries_scope_owner ON memory_entries(scope, owner_id, lifecycle_state, memory_type);
CREATE INDEX IF NOT EXISTS idx_memory_entries_task ON memory_entries(task_run_id, lifecycle_state);

CREATE TABLE IF NOT EXISTS memory_versions (
  id TEXT PRIMARY KEY,
  memory_entry_id TEXT NOT NULL,
  old_content TEXT NOT NULL DEFAULT '',
  new_content TEXT NOT NULL DEFAULT '',
  update_reason TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL DEFAULT '',
  reviewer_id TEXT NOT NULL DEFAULT '',
  rollback_allowed INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS memory_audits (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL DEFAULT '',
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  stale_count INTEGER NOT NULL DEFAULT 0,
  low_confidence_count INTEGER NOT NULL DEFAULT 0,
  privacy_risk_count INTEGER NOT NULL DEFAULT 0,
  migration_candidate_count INTEGER NOT NULL DEFAULT 0,
  actions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS communications (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  requested_info TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  blocking INTEGER NOT NULL DEFAULT 0,
  expected_format TEXT NOT NULL DEFAULT '',
  context_summary TEXT NOT NULL DEFAULT '',
  references_json TEXT NOT NULL DEFAULT '[]',
  response_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS typed_memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'agent',
  owner_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  agent_instance_id TEXT NOT NULL DEFAULT '',
  memory_document_id TEXT NOT NULL DEFAULT '',
  task_run_id TEXT NOT NULL DEFAULT '',
  relationship_id TEXT NOT NULL DEFAULT '',
  memory_type TEXT NOT NULL,
  content TEXT NOT NULL,
  privacy_level TEXT NOT NULL DEFAULT 'public_reusable',
  confidence REAL NOT NULL DEFAULT 0.5,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  source_kind TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL DEFAULT '',
  merge_result_json TEXT NOT NULL DEFAULT '{}',
  entailment_status TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_typed_memories_owner ON typed_memories(scope, owner_id, memory_type, status);
CREATE INDEX IF NOT EXISTS idx_typed_memories_agent_type_status ON typed_memories(agent_id, memory_type, status, updated_at);

CREATE TABLE IF NOT EXISTS evolution_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL DEFAULT '',
  evolution_scope TEXT NOT NULL DEFAULT 'legacy',
  user_id TEXT NOT NULL DEFAULT '',
  user_agent_instance_id TEXT NOT NULL DEFAULT '',
  cohort_key TEXT NOT NULL DEFAULT '',
  algorithm_version TEXT NOT NULL DEFAULT 'legacy_v1',
  evidence_cursor_from TEXT NOT NULL DEFAULT '',
  evidence_cursor_to TEXT NOT NULL DEFAULT '',
  consent_snapshot_json TEXT NOT NULL DEFAULT '{}',
  department_id TEXT NOT NULL DEFAULT '',
  hr_id TEXT NOT NULL DEFAULT '',
  evidence_message_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  proposal_path TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT 'runtime_real',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS evolution_archives (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_family_id TEXT NOT NULL DEFAULT '',
  evolution_scope TEXT NOT NULL DEFAULT 'legacy',
  user_id TEXT NOT NULL DEFAULT '',
  user_agent_instance_id TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL DEFAULT '',
  proposal_path TEXT NOT NULL DEFAULT '',
  proposal_hash TEXT NOT NULL DEFAULT '',
  diagnostics_json TEXT NOT NULL DEFAULT '{}',
  gate_status TEXT NOT NULL DEFAULT '',
  gate_score REAL NOT NULL DEFAULT 0.0,
  gate_json TEXT NOT NULL DEFAULT '{}',
  applied INTEGER NOT NULL DEFAULT 0,
  pre_skill_hash TEXT NOT NULL DEFAULT '',
  post_skill_hash TEXT NOT NULL DEFAULT '',
  pre_memory_hash TEXT NOT NULL DEFAULT '',
  post_memory_hash TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT 'runtime_real',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS agent_evolution_reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  department_id TEXT NOT NULL DEFAULT '',
  hr_id TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL DEFAULT 'pending',
  rationale TEXT NOT NULL DEFAULT '',
  required_revision TEXT NOT NULL DEFAULT '',
  risks_json TEXT NOT NULL DEFAULT '[]',
  reviewer_output TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_evolution_reviews_run
  ON agent_evolution_reviews(run_id, created_at);

CREATE TABLE IF NOT EXISTS evolution_regression_evals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  department_id TEXT NOT NULL DEFAULT '',
  case_index INTEGER NOT NULL DEFAULT 0,
  case_text TEXT NOT NULL,
  input_text TEXT NOT NULL DEFAULT '',
  expected_text TEXT NOT NULL DEFAULT '',
  replay_spec_json TEXT NOT NULL DEFAULT '{}',
  evaluator_type TEXT NOT NULL DEFAULT 'static_plus_heuristic',
  status TEXT NOT NULL DEFAULT 'pending',
  score REAL NOT NULL DEFAULT 0.0,
  result_json TEXT NOT NULL DEFAULT '{}',
  judge_result_json TEXT NOT NULL DEFAULT '{}',
  source_proposal_hash TEXT NOT NULL DEFAULT '',
  skill_hash TEXT NOT NULL DEFAULT '',
  memory_hash TEXT NOT NULL DEFAULT '',
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_run_at TEXT
);

CREATE TABLE IF NOT EXISTS evolution_holdout_evals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL DEFAULT '',
  case_text TEXT NOT NULL,
  input_text TEXT NOT NULL DEFAULT '',
  expected_text TEXT NOT NULL DEFAULT '',
  replay_spec_json TEXT NOT NULL DEFAULT '{}',
  source_kind TEXT NOT NULL DEFAULT 'human_holdout',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS evolution_apply_journal (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  department_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'prepared',
  skill_path TEXT NOT NULL DEFAULT '',
  memory_path TEXT NOT NULL DEFAULT '',
  staged_skill_path TEXT NOT NULL DEFAULT '',
  staged_memory_path TEXT NOT NULL DEFAULT '',
  before_skill_hash TEXT NOT NULL DEFAULT '',
  before_memory_hash TEXT NOT NULL DEFAULT '',
  staged_skill_hash TEXT NOT NULL DEFAULT '',
  staged_memory_hash TEXT NOT NULL DEFAULT '',
  skill_before_snapshot_path TEXT NOT NULL DEFAULT '',
  memory_before_snapshot_path TEXT NOT NULL DEFAULT '',
  regression_json TEXT NOT NULL DEFAULT '{}',
  error_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_evolution_apply_journal_run
  ON evolution_apply_journal(run_id, status, created_at);

CREATE TABLE IF NOT EXISTS evolution_ab_replays (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  eval_id TEXT NOT NULL DEFAULT '',
  before_output TEXT NOT NULL DEFAULT '',
  after_output TEXT NOT NULL DEFAULT '',
  judge_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS evolution_gate_calibrations (
  id TEXT PRIMARY KEY,
  sample_count INTEGER NOT NULL DEFAULT 0,
  positive_count INTEGER NOT NULL DEFAULT 0,
  negative_count INTEGER NOT NULL DEFAULT 0,
  selected_min_score REAL NOT NULL DEFAULT 0.72,
  objective_json TEXT NOT NULL DEFAULT '{}',
  candidates_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS evolution_archive_labels (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  archive_id TEXT NOT NULL DEFAULT '',
  label INTEGER NOT NULL CHECK (label IN (0, 1)),
  label_source TEXT NOT NULL DEFAULT 'human',
  confidence REAL NOT NULL DEFAULT 1.0,
  rationale TEXT NOT NULL DEFAULT '',
  synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_evolution_gate_calibrations_status
  ON evolution_gate_calibrations(status, created_at);
CREATE INDEX IF NOT EXISTS idx_evolution_archive_labels_run
  ON evolution_archive_labels(run_id, synthetic, created_at);

CREATE TABLE IF NOT EXISTS hr_reviews (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  proposal_path TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  structural_json TEXT NOT NULL DEFAULT '{}',
  gate_json TEXT NOT NULL DEFAULT '{}',
  source_kind TEXT NOT NULL DEFAULT 'runtime_real',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS hr_governance_votes (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  department_id TEXT NOT NULL DEFAULT '',
  action_index INTEGER NOT NULL DEFAULT 0,
  action_type TEXT NOT NULL DEFAULT '',
  voter_agent_id TEXT NOT NULL,
  vote TEXT NOT NULL DEFAULT 'abstain',
  rationale TEXT NOT NULL DEFAULT '',
  response_hash TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT 'independent_runtime_vote',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(review_id, action_index, voter_agent_id)
);

CREATE INDEX IF NOT EXISTS idx_hr_governance_votes_review
  ON hr_governance_votes(review_id, action_index, voter_agent_id);

CREATE TABLE IF NOT EXISTS hr_apply_journal (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  department_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'prepared',
  hr_memory_path TEXT NOT NULL DEFAULT '',
  hr_memory_snapshot_path TEXT NOT NULL DEFAULT '',
  rollback_manifest_json TEXT NOT NULL DEFAULT '[]',
  structural_json TEXT NOT NULL DEFAULT '{}',
  error_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_credit_assignments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL DEFAULT '',
  review_id TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  workflow_step TEXT NOT NULL DEFAULT '',
  failure_type TEXT NOT NULL DEFAULT '',
  responsibility REAL NOT NULL DEFAULT 0.0,
  evidence_summary TEXT NOT NULL DEFAULT '',
  recommendation TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_credit_department
  ON workflow_credit_assignments(department_id, status, created_at);

CREATE TABLE IF NOT EXISTS agent_governance_events (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  evidence_count INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0.0,
  rationale TEXT NOT NULL DEFAULT '',
  migration_plan TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  source_review_id TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT 'runtime_real',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_governance_events_department ON agent_governance_events(department_id, created_at);

CREATE TABLE IF NOT EXISTS agent_performance_reviews (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  agent_family_id TEXT NOT NULL DEFAULT '',
  user_agent_instance_id TEXT NOT NULL DEFAULT '',
  review_type TEXT NOT NULL DEFAULT 'periodic',
  rating TEXT NOT NULL DEFAULT 'observe',
  task_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  communication_count INTEGER NOT NULL DEFAULT 0,
  memory_health_json TEXT NOT NULL DEFAULT '{}',
  recommendation TEXT NOT NULL DEFAULT '',
  score REAL NOT NULL DEFAULT 0.0,
  scenario_metrics_json TEXT NOT NULL DEFAULT '{}',
  skill_version_id TEXT NOT NULL DEFAULT '',
  skill_hash TEXT NOT NULL DEFAULT '',
  source_review_id TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT 'runtime_real',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS specialist_experiments (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL DEFAULT '',
  candidate_agent_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'assessment_pending',
  baseline_agent_id TEXT NOT NULL DEFAULT '',
  started_by_review_id TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'assessment_pending',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  decision_notes TEXT NOT NULL DEFAULT '',
  baseline_task_run_id TEXT NOT NULL DEFAULT '',
  candidate_task_run_id TEXT NOT NULL DEFAULT '',
  evaluation_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  user_agent_instance_id TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  source_run_id TEXT NOT NULL DEFAULT '',
  skill_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS attached_skill_packages (
  id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,source_type TEXT NOT NULL DEFAULT 'local',
  source_uri TEXT NOT NULL DEFAULT '',source_revision TEXT NOT NULL DEFAULT '',install_root TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'installed',content_hash TEXT NOT NULL,metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(source_type IN ('local','github','builtin')),CHECK(status IN ('installed','invalid','disabled'))
);
CREATE INDEX IF NOT EXISTS idx_attached_skill_packages_owner ON attached_skill_packages(owner_user_id,status,updated_at);
CREATE TABLE IF NOT EXISTS attached_skills (
  id TEXT PRIMARY KEY,package_id TEXT NOT NULL,skill_key TEXT NOT NULL,name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',relative_path TEXT NOT NULL,content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(package_id,skill_key),CHECK(status IN ('ready','invalid','disabled')),
  FOREIGN KEY(package_id) REFERENCES attached_skill_packages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attached_skills_package ON attached_skills(package_id,status,name);
CREATE TABLE IF NOT EXISTS attached_skill_assignments (
  id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,skill_id TEXT NOT NULL,scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(owner_user_id,skill_id,scope_type,scope_id),
  CHECK(scope_type IN ('department','agent_family','agent_instance')),CHECK(enabled IN (0,1)),
  FOREIGN KEY(skill_id) REFERENCES attached_skills(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attached_skill_assignments_scope ON attached_skill_assignments(owner_user_id,scope_type,scope_id,enabled);
CREATE INDEX IF NOT EXISTS idx_attached_skill_assignments_skill ON attached_skill_assignments(skill_id,owner_user_id,enabled);

CREATE TABLE IF NOT EXISTS organization_research_cache_state (
  organization_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,device_id TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,wrapped_data_key TEXT NOT NULL DEFAULT '',wrapped_lease_token TEXT NOT NULL DEFAULT '',
  lease_id TEXT NOT NULL DEFAULT '',lease_expires_at TEXT NOT NULL DEFAULT '',encrypted_shard_path TEXT NOT NULL DEFAULT '',
  cache_status TEXT NOT NULL DEFAULT 'empty',last_synced_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(cache_status IN ('empty','ready','locked','destroyed','error'))
);

CREATE TABLE IF NOT EXISTS organization_research_contexts (
  id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,user_id TEXT NOT NULL,topic_hash TEXT NOT NULL,
  encrypted_result TEXT NOT NULL DEFAULT '',citation_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',
  CHECK(status IN ('active','expired','locked'))
);
CREATE INDEX IF NOT EXISTS idx_organization_research_context_active
  ON organization_research_contexts(organization_id,user_id,status,expires_at);

CREATE TABLE IF NOT EXISTS organization_research_audit_outbox (
  id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,organization_id TEXT NOT NULL,user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,encrypted_payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT NOT NULL DEFAULT '',
  CHECK(status IN ('pending','sending','completed','failed'))
);
CREATE INDEX IF NOT EXISTS idx_organization_research_audit_outbox_due
  ON organization_research_audit_outbox(organization_id,user_id,status,next_attempt_at,created_at);
`;
