CREATE TABLE IF NOT EXISTS cloud_task_runs (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cloud_task_nodes (
  id text PRIMARY KEY,
  task_run_id text NOT NULL DEFAULT '',
  user_agent_instance_id text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_agent_performance_events (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL,
  agent_family_id text NOT NULL,
  task_id text NOT NULL DEFAULT '',
  task_type_key text NOT NULL DEFAULT 'general',
  event_kind text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,user_agent_instance_id,task_id,event_kind,occurred_at)
);
CREATE INDEX IF NOT EXISTS idx_cloud_performance_events_instance ON cloud_agent_performance_events(user_agent_instance_id,occurred_at);

CREATE TABLE IF NOT EXISTS cloud_agent_performance_history (
  id text PRIMARY KEY,
  user_agent_instance_id text NOT NULL,
  algorithm_version text NOT NULL,
  window_started_at timestamptz NOT NULL,
  window_ended_at timestamptz NOT NULL,
  input_hash text NOT NULL,
  score double precision NOT NULL,
  level text NOT NULL,
  provisional boolean NOT NULL DEFAULT true,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_agent_instance_id,algorithm_version,input_hash)
);

CREATE TABLE IF NOT EXISTS cloud_agent_cohort_members (
  cohort_id text NOT NULL,
  user_agent_instance_id text NOT NULL,
  owner_user_id text NOT NULL,
  agent_family_id text NOT NULL,
  performance_level text NOT NULL DEFAULT 'P1',
  raw_weight double precision NOT NULL DEFAULT 0,
  effective_weight double precision NOT NULL DEFAULT 0,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(cohort_id,user_agent_instance_id)
);

CREATE TABLE IF NOT EXISTS cloud_market_candidate_sections (
  candidate_id text NOT NULL,
  section_id text NOT NULL,
  title text NOT NULL,
  content_hash text NOT NULL,
  content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  support_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(candidate_id,section_id)
);

CREATE TABLE IF NOT EXISTS cloud_market_evaluations (
  id text PRIMARY KEY,
  candidate_id text NOT NULL,
  evaluation_kind text NOT NULL,
  case_index integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'completed',
  regression boolean NOT NULL DEFAULT false,
  privacy_violation boolean NOT NULL DEFAULT false,
  role_violation boolean NOT NULL DEFAULT false,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(candidate_id,evaluation_kind,case_index)
);

CREATE TABLE IF NOT EXISTS cloud_market_version_sections (
  market_version_id text NOT NULL,
  section_id text NOT NULL,
  title text NOT NULL,
  content_hash text NOT NULL,
  content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ordinal integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(market_version_id,section_id)
);

CREATE TABLE IF NOT EXISTS cloud_market_adoption_actions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL,
  market_version_id text NOT NULL,
  section_id text NOT NULL,
  action text NOT NULL,
  conflict_resolution text NOT NULL DEFAULT 'none',
  previous_status text NOT NULL DEFAULT '',
  next_status text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_effective_skill_projections (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL,
  market_version_id text NOT NULL DEFAULT '',
  adopted_sections_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflicts_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  effective_skill_hash text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,user_agent_instance_id)
);
