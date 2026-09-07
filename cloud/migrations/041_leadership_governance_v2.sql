-- requires-real-postgres: compatibility upgrade; fresh pg-mem schemas already receive this table from migration 033.
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
