CREATE TABLE IF NOT EXISTS cloud_agent_leadership_events (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL,
  agent_family_id text NOT NULL DEFAULT '',
  task_id text NOT NULL DEFAULT '',
  work_scope_id text NOT NULL DEFAULT '',
  assignment_id text NOT NULL DEFAULT '',
  event_kind text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,user_agent_instance_id,task_id,assignment_id,event_kind,occurred_at)
);
CREATE INDEX IF NOT EXISTS idx_cloud_leadership_events_instance
  ON cloud_agent_leadership_events(user_agent_instance_id,occurred_at);

CREATE TABLE IF NOT EXISTS cloud_agent_leadership_evaluations (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL,
  task_id text NOT NULL,
  assignment_id text NOT NULL DEFAULT '',
  algorithm_version text NOT NULL,
  score double precision NOT NULL CHECK(score>=0 AND score<=100),
  evaluation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_agent_instance_id,task_id,assignment_id,algorithm_version)
);

CREATE TABLE IF NOT EXISTS cloud_agent_leadership_levels (
  user_agent_instance_id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_family_id text NOT NULL DEFAULT '',
  score double precision NOT NULL DEFAULT 0 CHECK(score>=0 AND score<=100),
  level text NOT NULL DEFAULT 'L0' CHECK(level IN ('L0','L1','L2','L3')),
  provisional boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','frozen','inactive')),
  leadership_task_count integer NOT NULL DEFAULT 0,
  state_revision integer NOT NULL DEFAULT 0,
  consecutive_low_windows integer NOT NULL DEFAULT 0,
  last_low_input_hash text NOT NULL DEFAULT '',
  last_low_evaluated_at timestamptz,
  last_low_task_count integer NOT NULL DEFAULT 0,
  level_changed_at timestamptz,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_agent_leadership_history (
  id text PRIMARY KEY,
  user_agent_instance_id text NOT NULL,
  algorithm_version text NOT NULL,
  input_hash text NOT NULL,
  score double precision NOT NULL CHECK(score>=0 AND score<=100),
  level text NOT NULL CHECK(level IN ('L0','L1','L2','L3')),
  provisional boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','frozen','inactive')),
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_agent_instance_id,algorithm_version,input_hash)
);

CREATE TABLE IF NOT EXISTS cloud_leadership_promotion_actions (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL,
  action text NOT NULL CHECK(action IN ('trial_requested','trial_approved','promote','reject','demote','freeze','restore')),
  from_level text NOT NULL DEFAULT 'L0' CHECK(from_level IN ('L0','L1','L2','L3')),
  to_level text NOT NULL DEFAULT 'L0' CHECK(to_level IN ('L0','L1','L2','L3')),
  status text NOT NULL DEFAULT 'pending',
  command_id text NOT NULL DEFAULT '',
  actor_id text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  evidence_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_leadership_action_command
  ON cloud_leadership_promotion_actions(owner_user_id,command_id) WHERE command_id<>'';

CREATE TABLE IF NOT EXISTS cloud_leadership_appeals (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL,
  leadership_action_id text NOT NULL DEFAULT '',
  appeal_kind text NOT NULL CHECK(appeal_kind IN ('assessment','promotion','demotion','freeze','restore')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','withdrawn')),
  command_id text NOT NULL DEFAULT '',
  submitted_reason text NOT NULL DEFAULT '',
  reviewer_user_id text NOT NULL DEFAULT '',
  reviewer_reason text NOT NULL DEFAULT '',
  evidence_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_leadership_appeal_command
  ON cloud_leadership_appeals(owner_user_id,command_id) WHERE command_id<>'';
CREATE INDEX IF NOT EXISTS idx_cloud_leadership_appeals_review
  ON cloud_leadership_appeals(status,created_at);

ALTER TABLE cloud_leadership_assignments ADD COLUMN IF NOT EXISTS assignment_mode text NOT NULL DEFAULT 'normal';
ALTER TABLE cloud_leadership_assignments ADD COLUMN IF NOT EXISTS limit_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE cloud_leadership_assignments ADD CONSTRAINT chk_cloud_leadership_assignment_mode
  CHECK(assignment_mode IN ('normal','trial'));
