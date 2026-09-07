ALTER TABLE cloud_agent_cohorts
  ADD COLUMN IF NOT EXISTS cohort_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS identity_version text NOT NULL DEFAULT 'cluster_cohort_identity_v1';

UPDATE cloud_agent_cohorts SET cohort_key=CASE
  WHEN COALESCE(payload_json->>'cohortKey','')<>'' THEN payload_json->>'cohortKey'
  WHEN agent_family_id<>'' THEN 'family:' || agent_family_id
  ELSE 'legacy:' || id END
WHERE cohort_key='';

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_cohorts_key ON cloud_agent_cohorts(cohort_key);

CREATE TABLE IF NOT EXISTS cloud_cluster_evidence_claims (
  evidence_id text PRIMARY KEY REFERENCES cloud_evolution_evidence(evidence_id) ON DELETE CASCADE,
  consumer_id text NOT NULL,run_id text NOT NULL,
  claim_state text NOT NULL CHECK(claim_state IN ('reserved','consumed')),
  claimed_at timestamptz NOT NULL DEFAULT now(),terminal_at timestamptz,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cloud_cluster_claims_consumer
  ON cloud_cluster_evidence_claims(consumer_id,claim_state,updated_at);

ALTER TABLE cloud_evolution_run_snapshots
  ADD COLUMN IF NOT EXISTS cohort_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS canary_cases_ciphertext text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS canary_cases_nonce text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS canary_cases_tag text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS canary_cases_algorithm text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS canary_cases_key_id text NOT NULL DEFAULT '';

ALTER TABLE cloud_market_agent_candidates
  ADD COLUMN IF NOT EXISTS run_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS revision_no integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS diagnosis_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS gate_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS governance_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS canary_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS canary_deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS status_reason text NOT NULL DEFAULT '';

ALTER TABLE cloud_market_agent_versions
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS status_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS health_baseline_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE cloud_user_market_adoptions
  ADD COLUMN IF NOT EXISTS adoption_mode text NOT NULL DEFAULT 'sections';

ALTER TABLE cloud_market_adoption_actions
  ADD COLUMN IF NOT EXISTS command_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS payload_json jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_market_adoption_command
  ON cloud_market_adoption_actions(user_id,command_id,section_id) WHERE command_id<>'';

CREATE TABLE IF NOT EXISTS cloud_market_candidate_family_sections (
  candidate_id text NOT NULL,agent_family_id text NOT NULL,section_id text NOT NULL,
  title text NOT NULL,content_hash text NOT NULL,content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  support_count integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'canary',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(candidate_id,agent_family_id,section_id)
);

CREATE TABLE IF NOT EXISTS cloud_market_version_health (
  market_version_id text PRIMARY KEY,user_count integer NOT NULL DEFAULT 0,
  observed_task_count integer NOT NULL DEFAULT 0,baseline_score double precision NOT NULL DEFAULT 0,
  latest_score double precision NOT NULL DEFAULT 0,baseline_failure_rate double precision NOT NULL DEFAULT 0,
  latest_failure_rate double precision NOT NULL DEFAULT 0,consecutive_regression_windows integer NOT NULL DEFAULT 0,
  last_input_hash text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'collecting',
  status_reason text NOT NULL DEFAULT '',evaluated_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now()
);

DROP INDEX IF EXISTS idx_cloud_evolution_active_cluster_run;
CREATE UNIQUE INDEX idx_cloud_evolution_active_cluster_run ON cloud_evolution_runs(cohort_id)
  WHERE evolution_scope='cluster' AND status IN ('queued','claimed','running','proposed','canary');

-- requires-real-postgres-tail: pg-mem does not preserve named CHECK constraints from the real migration chain.
ALTER TABLE cloud_evolution_runs DROP CONSTRAINT IF EXISTS chk_cloud_evolution_run_status;
ALTER TABLE cloud_evolution_runs ADD CONSTRAINT chk_cloud_evolution_run_status CHECK(status IN
  ('queued','claimed','running','proposed','canary','applied','failed_retryable','failed_terminal','evaluated_rejected','rolled_back','skipped','insufficient_evidence'));
ALTER TABLE cloud_evolution_jobs DROP CONSTRAINT IF EXISTS chk_cloud_evolution_job_kind;
ALTER TABLE cloud_evolution_jobs ADD CONSTRAINT chk_cloud_evolution_job_kind CHECK(job_kind IN
  ('personal_evolution','cluster_evolution','cluster_canary','market_health'));
ALTER TABLE cloud_market_agent_candidates DROP CONSTRAINT IF EXISTS chk_cloud_market_candidate_status;
ALTER TABLE cloud_market_agent_candidates ADD CONSTRAINT chk_cloud_market_candidate_status CHECK(status IN
  ('draft','canary','released','rejected','archived'));
ALTER TABLE cloud_market_agent_versions DROP CONSTRAINT IF EXISTS chk_cloud_market_version_status;
ALTER TABLE cloud_market_agent_versions ADD CONSTRAINT chk_cloud_market_version_status CHECK(status IN
  ('draft','released','suspended','rejected','archived'));
ALTER TABLE cloud_user_market_adoptions ADD CONSTRAINT chk_cloud_market_adoption_mode CHECK(adoption_mode IN ('full','sections'));
