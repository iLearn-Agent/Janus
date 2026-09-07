CREATE TABLE IF NOT EXISTS ubuddy_org_trace_events (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  trace_id text NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('dispatch','terminal','correction')),
  task_type text NOT NULL DEFAULT '',
  task_signature text NOT NULL DEFAULT '',
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_created_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ubuddy_org_trace_owner_time
  ON ubuddy_org_trace_events(owner_user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_ubuddy_org_trace_cluster
  ON ubuddy_org_trace_events(owner_user_id,task_type,event_kind,created_at DESC);

CREATE TABLE IF NOT EXISTS ubuddy_org_pattern_evidence (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  pattern_key text NOT NULL,
  evidence_trace_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_count integer NOT NULL CHECK (evidence_count >= 1),
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,pattern_key,evidence_count)
);

CREATE TABLE IF NOT EXISTS ubuddy_org_evolution_run_events (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  run_id text NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('started','candidate_created','no_change','failed')),
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ubuddy_org_run_events
  ON ubuddy_org_evolution_run_events(owner_user_id,run_id,created_at,id);

CREATE TABLE IF NOT EXISTS ubuddy_org_policy_versions (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  parent_policy_version_id text NOT NULL DEFAULT '',
  stage text NOT NULL CHECK (stage IN ('shadow','assignment','decomposition')),
  policy_hash text NOT NULL,
  playbook_json jsonb NOT NULL,
  evidence_count integer NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,policy_hash)
);

CREATE INDEX IF NOT EXISTS idx_ubuddy_org_policy_owner_time
  ON ubuddy_org_policy_versions(owner_user_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS ubuddy_org_policy_evaluations (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  policy_version_id text NOT NULL,
  evaluation_kind text NOT NULL CHECK (evaluation_kind IN ('schema','historical_replay','shadow','health')),
  status text NOT NULL CHECK (status IN ('passed','failed','insufficient')),
  metrics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,policy_version_id,evaluation_kind)
);

CREATE TABLE IF NOT EXISTS ubuddy_org_activation_commands (
  id text PRIMARY KEY,
  sequence_id bigserial UNIQUE,
  owner_user_id text NOT NULL,
  command_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('activate','disable','auto_disable')),
  policy_version_id text NOT NULL DEFAULT '',
  expected_active_policy_version_id text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,command_id)
);

CREATE INDEX IF NOT EXISTS idx_ubuddy_org_activation_current
  ON ubuddy_org_activation_commands(owner_user_id,sequence_id DESC);

CREATE TABLE IF NOT EXISTS ubuddy_org_policy_health_events (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  policy_version_id text NOT NULL,
  trace_id text NOT NULL DEFAULT '',
  event_kind text NOT NULL CHECK (event_kind IN ('applied','success','failure','contract_rejected','auto_disabled')),
  idempotency_key text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ubuddy_org_health_policy
  ON ubuddy_org_policy_health_events(owner_user_id,policy_version_id,created_at DESC);
