ALTER TABLE cloud_follower_personal_versions
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS replay_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS decision_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS baseline_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE cloud_follower_personal_versions DROP CONSTRAINT IF EXISTS chk_follower_personal_review_status;
ALTER TABLE cloud_follower_personal_versions
  ADD CONSTRAINT chk_follower_personal_review_status CHECK(review_status IN ('pending','passed','failed'));
ALTER TABLE cloud_follower_personal_versions DROP CONSTRAINT IF EXISTS chk_follower_personal_replay_status;
ALTER TABLE cloud_follower_personal_versions
  ADD CONSTRAINT chk_follower_personal_replay_status CHECK(replay_status IN ('pending','passed','failed'));
ALTER TABLE cloud_follower_personal_versions DROP CONSTRAINT IF EXISTS chk_follower_personal_decision_status;
ALTER TABLE cloud_follower_personal_versions
  ADD CONSTRAINT chk_follower_personal_decision_status CHECK(decision_status IN ('pending','accepted','rejected','rolled_back'));

CREATE TABLE IF NOT EXISTS cloud_follower_personal_decisions (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_workspace_id text NOT NULL DEFAULT 'workspace_personal',
  service_instance_id text NOT NULL,
  version_id text NOT NULL REFERENCES cloud_follower_personal_versions(id) ON DELETE RESTRICT,
  version_kind text NOT NULL,
  decision text NOT NULL,
  expected_state_revision bigint NOT NULL,
  resulting_state_revision bigint NOT NULL,
  command_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,account_workspace_id,command_id),
  CHECK(version_kind IN ('personal_overlay','preference_memory')),
  CHECK(decision IN ('accept','reject')),
  CHECK(expected_state_revision>=1),
  CHECK(resulting_state_revision>=1)
);

ALTER TABLE cloud_follower_cluster_candidates
  ADD COLUMN IF NOT EXISTS evidence_snapshot_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS maximum_user_weight_share real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS governance_review_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS shadow_status text NOT NULL DEFAULT 'pending';

ALTER TABLE cloud_follower_cluster_candidates DROP CONSTRAINT IF EXISTS chk_follower_candidate_governance_status;
ALTER TABLE cloud_follower_cluster_candidates
  ADD CONSTRAINT chk_follower_candidate_governance_status CHECK(governance_review_status IN ('pending','passed','failed'));
ALTER TABLE cloud_follower_cluster_candidates DROP CONSTRAINT IF EXISTS chk_follower_candidate_shadow_status;
ALTER TABLE cloud_follower_cluster_candidates
  ADD CONSTRAINT chk_follower_candidate_shadow_status CHECK(shadow_status IN ('pending','passed','failed'));
ALTER TABLE cloud_follower_cluster_candidates DROP CONSTRAINT IF EXISTS chk_follower_candidate_user_weight;
ALTER TABLE cloud_follower_cluster_candidates
  ADD CONSTRAINT chk_follower_candidate_user_weight CHECK(maximum_user_weight_share>=0 AND maximum_user_weight_share<=1);

CREATE TABLE IF NOT EXISTS cloud_follower_cluster_candidate_evidence (
  candidate_id text NOT NULL REFERENCES cloud_follower_cluster_candidates(id) ON DELETE CASCADE,
  evidence_id text NOT NULL REFERENCES cloud_follower_preference_signals(evidence_id) ON DELETE RESTRICT,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_instance_id text NOT NULL,
  lineage_key text NOT NULL,
  evidence_role text NOT NULL DEFAULT 'training',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(candidate_id,evidence_id),
  CHECK(evidence_role IN ('training','shadow_holdout'))
);
CREATE INDEX IF NOT EXISTS idx_follower_candidate_evidence_owner
  ON cloud_follower_cluster_candidate_evidence(candidate_id,owner_user_id,service_instance_id);

CREATE TABLE IF NOT EXISTS cloud_follower_cluster_reviews (
  id text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES cloud_follower_cluster_candidates(id) ON DELETE CASCADE,
  review_kind text NOT NULL,
  decision text NOT NULL,
  reviewer_user_id text NOT NULL,
  metrics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(candidate_id,review_kind),
  CHECK(review_kind IN ('governance','shadow')),
  CHECK(decision IN ('passed','failed'))
);

ALTER TABLE cloud_follower_canary_evaluations
  ADD COLUMN IF NOT EXISTS holdout_verified boolean NOT NULL DEFAULT false;
