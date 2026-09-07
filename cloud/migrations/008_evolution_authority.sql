CREATE TABLE IF NOT EXISTS cloud_sync_grants (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, device_id)
);

CREATE TABLE IF NOT EXISTS cloud_agent_families_v3 (
  id text PRIMARY KEY,
  department_id text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'agent',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_agent_versions_v3 (
  id text PRIMARY KEY,
  agent_family_id text NOT NULL,
  content_hash text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_user_agent_instances_v3 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  agent_family_id text NOT NULL,
  base_agent_version_id text NOT NULL DEFAULT '',
  active_personal_skill_version_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  sync_enabled boolean NOT NULL DEFAULT true,
  personal_evolution_consent boolean NOT NULL DEFAULT true,
  cluster_contribution_consent boolean NOT NULL DEFAULT false,
  personal_skill_auto_activate boolean NOT NULL DEFAULT false,
  source_device_id text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_user_agent_instances_family
  ON cloud_user_agent_instances_v3(user_id,agent_family_id,created_at,id);

CREATE TABLE IF NOT EXISTS cloud_user_evolution_preferences (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  policy_version text NOT NULL DEFAULT 'evolution_default_on_account_pause_v1',
  state_revision bigint NOT NULL DEFAULT 1,
  last_command_id text NOT NULL DEFAULT '',
  paused_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(state_revision >= 1)
);

CREATE TABLE IF NOT EXISTS cloud_memory_documents_v3 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  user_agent_instance_id text NOT NULL,
  scope text NOT NULL DEFAULT 'general',
  slot_no integer NOT NULL DEFAULT 0,
  current_version_id text NOT NULL DEFAULT '',
  lifecycle_state text NOT NULL DEFAULT 'active',
  sync_enabled boolean NOT NULL DEFAULT true,
  allow_personal_evolution boolean NOT NULL DEFAULT true,
  allow_cluster_evolution boolean NOT NULL DEFAULT false,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, id)
);

CREATE TABLE IF NOT EXISTS cloud_memory_document_versions_v3 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  memory_document_id text NOT NULL,
  version_no integer NOT NULL DEFAULT 1,
  content_hash text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, id),
  UNIQUE(user_id, memory_document_id, version_no)
);

CREATE TABLE IF NOT EXISTS cloud_evolution_evidence (
  evidence_id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL,
  agent_family_id text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  source_version_id text NOT NULL DEFAULT '',
  context_space_id text NOT NULL DEFAULT '',
  task_id text NOT NULL DEFAULT '',
  delegation_id text NOT NULL DEFAULT '',
  content_hash text NOT NULL,
  content_ciphertext text NOT NULL,
  content_nonce text NOT NULL DEFAULT '',
  content_tag text NOT NULL DEFAULT '',
  encryption_algorithm text NOT NULL DEFAULT 'aes-256-gcm',
  key_id text NOT NULL DEFAULT '',
  confidence double precision NOT NULL DEFAULT 1,
  privacy_level text NOT NULL DEFAULT 'owner_private',
  quarantine_reason text NOT NULL DEFAULT '',
  occurred_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(owner_user_id, user_agent_instance_id, source_kind, source_id, source_version_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_cloud_evolution_evidence_subject
  ON cloud_evolution_evidence(owner_user_id, user_agent_instance_id, occurred_at, evidence_id);

CREATE TABLE IF NOT EXISTS cloud_evolution_evidence_usage (
  evidence_id text NOT NULL REFERENCES cloud_evolution_evidence(evidence_id) ON DELETE CASCADE,
  evolution_scope text NOT NULL,
  consumer_id text NOT NULL,
  status text NOT NULL DEFAULT 'available',
  run_id text NOT NULL DEFAULT '',
  algorithm_version text NOT NULL DEFAULT '',
  re_evaluation_basis_hash text NOT NULL DEFAULT '',
  rejection_kind text NOT NULL DEFAULT '',
  transition_reason text NOT NULL DEFAULT '',
  reserved_at timestamptz,
  lease_expires_at timestamptz,
  terminal_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(evidence_id, evolution_scope, consumer_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_evolution_usage_consumer
  ON cloud_evolution_evidence_usage(evolution_scope, consumer_id, status, updated_at);

CREATE TABLE IF NOT EXISTS cloud_evolution_runs (
  id text PRIMARY KEY,
  evolution_scope text NOT NULL,
  owner_user_id text NOT NULL DEFAULT '',
  user_agent_instance_id text NOT NULL DEFAULT '',
  agent_family_id text NOT NULL,
  cohort_id text NOT NULL DEFAULT '',
  consumer_id text NOT NULL,
  algorithm_version text NOT NULL,
  trigger_kind text NOT NULL DEFAULT 'scheduled',
  status text NOT NULL DEFAULT 'queued',
  evidence_count integer NOT NULL DEFAULT 0,
  base_agent_version_id text NOT NULL DEFAULT '',
  base_personal_skill_version_id text NOT NULL DEFAULT '',
  candidate_personal_skill_version_id text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  error_code text NOT NULL DEFAULT '',
  error_text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_evolution_active_personal_run
  ON cloud_evolution_runs(user_agent_instance_id)
  WHERE evolution_scope = 'personal' AND status IN ('queued','claimed','running','proposed');

CREATE TABLE IF NOT EXISTS cloud_evolution_jobs (
  id text PRIMARY KEY,
  run_id text NOT NULL UNIQUE REFERENCES cloud_evolution_runs(id) ON DELETE CASCADE,
  job_kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text NOT NULL DEFAULT '',
  lease_expires_at timestamptz,
  error_code text NOT NULL DEFAULT '',
  error_text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS cloud_evolution_run_snapshots (
  run_id text PRIMARY KEY REFERENCES cloud_evolution_runs(id) ON DELETE CASCADE,
  snapshot_hash text NOT NULL,
  evidence_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  base_skill_ciphertext text NOT NULL DEFAULT '',
  personal_overlay_ciphertext text NOT NULL DEFAULT '',
  memory_manifest_ciphertext text NOT NULL DEFAULT '',
  encryption_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_evolution_evaluations (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES cloud_evolution_runs(id) ON DELETE CASCADE,
  evaluation_kind text NOT NULL,
  case_index integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  regression boolean NOT NULL DEFAULT false,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, evaluation_kind, case_index)
);

CREATE TABLE IF NOT EXISTS cloud_evolution_apply_journals (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES cloud_evolution_runs(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL,
  previous_skill_version_id text NOT NULL DEFAULT '',
  next_skill_version_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'prepared',
  error_text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS cloud_personal_skill_overlay_versions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL,
  agent_family_id text NOT NULL,
  base_agent_version_id text NOT NULL DEFAULT '',
  parent_version_id text NOT NULL DEFAULT '',
  source_run_id text NOT NULL DEFAULT '',
  authority text NOT NULL DEFAULT 'cloud',
  stability_status text NOT NULL DEFAULT 'candidate',
  status text NOT NULL DEFAULT 'candidate',
  overlay_hash text NOT NULL DEFAULT '',
  effective_skill_hash text NOT NULL DEFAULT '',
  compiler_version text NOT NULL DEFAULT 'overlay_concat_v1',
  content_ciphertext text NOT NULL DEFAULT '',
  content_nonce text NOT NULL DEFAULT '',
  content_tag text NOT NULL DEFAULT '',
  encryption_algorithm text NOT NULL DEFAULT 'aes-256-gcm',
  key_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  archived_at timestamptz
);

CREATE TABLE IF NOT EXISTS cloud_personal_version_commands (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  command_id text NOT NULL,
  user_agent_instance_id text NOT NULL,
  action text NOT NULL,
  target_version_id text NOT NULL DEFAULT '',
  expected_active_version_id text NOT NULL DEFAULT '',
  previous_active_version_id text NOT NULL DEFAULT '',
  result_active_version_id text NOT NULL DEFAULT '',
  actor_device_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'confirmed',
  error_code text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY(user_id,command_id)
);

CREATE TABLE IF NOT EXISTS cloud_personal_evolution_proposals_v4 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  user_agent_instance_id text NOT NULL,
  agent_family_id text NOT NULL,
  status text NOT NULL DEFAULT 'ready',
  proposal_hash text NOT NULL DEFAULT '',
  origin_device_id text NOT NULL DEFAULT 'cloud-authority',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, id)
);

CREATE TABLE IF NOT EXISTS cloud_personal_evolution_memory_operations_v4 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  proposal_id text NOT NULL,
  memory_document_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, id)
);

CREATE TABLE IF NOT EXISTS cloud_personal_evolution_actions_v4 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  proposal_id text NOT NULL,
  target_kind text NOT NULL,
  target_id text NOT NULL DEFAULT '',
  decision text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  actor_device_id text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, id),
  UNIQUE(user_id, proposal_id, target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_personal_proposals_instance_v4
  ON cloud_personal_evolution_proposals_v4(user_id, user_agent_instance_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_cloud_personal_actions_proposal_v4
  ON cloud_personal_evolution_actions_v4(user_id, proposal_id, received_at);

CREATE TABLE IF NOT EXISTS cloud_personal_version_health (
  personal_skill_version_id text PRIMARY KEY REFERENCES cloud_personal_skill_overlay_versions(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL,
  baseline_score double precision NOT NULL DEFAULT 0,
  baseline_failure_rate double precision NOT NULL DEFAULT 0,
  observed_task_count integer NOT NULL DEFAULT 0,
  latest_score double precision NOT NULL DEFAULT 0,
  latest_failure_rate double precision NOT NULL DEFAULT 0,
  consecutive_regression_windows integer NOT NULL DEFAULT 0,
  last_performance_input_hash text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'collecting',
  evaluated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_agent_performance_levels (
  user_agent_instance_id text PRIMARY KEY,
  agent_family_id text NOT NULL,
  score double precision NOT NULL DEFAULT 0,
  level text NOT NULL DEFAULT 'P1',
  provisional boolean NOT NULL DEFAULT true,
  completed_task_count integer NOT NULL DEFAULT 0,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_agent_cohorts (
  id text PRIMARY KEY,
  agent_family_id text NOT NULL DEFAULT '',
  department_id text NOT NULL DEFAULT '',
  capability_tags_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'disabled',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_market_agent_candidates (
  id text PRIMARY KEY,
  cohort_id text NOT NULL,
  agent_family_id text NOT NULL,
  status text NOT NULL DEFAULT 'disabled',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_market_agent_versions (
  id text PRIMARY KEY,
  agent_family_id text NOT NULL,
  parent_version_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'disabled',
  sections_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_user_market_adoptions (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL,
  market_version_id text NOT NULL,
  section_id text NOT NULL DEFAULT '*',
  status text NOT NULL DEFAULT 'disabled',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, user_agent_instance_id, market_version_id, section_id)
);

CREATE TABLE IF NOT EXISTS cloud_memory_access_audits (
  id text PRIMARY KEY,
  requester_identity text NOT NULL,
  owner_user_id text NOT NULL,
  user_agent_instance_id text NOT NULL,
  memory_document_id text NOT NULL DEFAULT '',
  evidence_id text NOT NULL DEFAULT '',
  run_id text NOT NULL DEFAULT '',
  purpose text NOT NULL,
  result text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
