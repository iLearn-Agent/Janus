ALTER TABLE cloud_evolution_run_snapshots
  ADD COLUMN IF NOT EXISTS shadow_cases_ciphertext text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS shadow_cases_nonce text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS shadow_cases_tag text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS shadow_cases_algorithm text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS shadow_cases_key_id text NOT NULL DEFAULT '';

UPDATE cloud_evolution_run_snapshots SET
  shadow_cases_ciphertext=canary_cases_ciphertext,
  shadow_cases_nonce=canary_cases_nonce,
  shadow_cases_tag=canary_cases_tag,
  shadow_cases_algorithm=canary_cases_algorithm,
  shadow_cases_key_id=canary_cases_key_id
WHERE shadow_cases_ciphertext='' AND canary_cases_ciphertext<>'';

ALTER TABLE cloud_market_agent_candidates
  ADD COLUMN IF NOT EXISTS shadow_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS shadow_completed_at timestamptz;

ALTER TABLE cloud_market_agent_versions
  ADD COLUMN IF NOT EXISTS version_kind text NOT NULL DEFAULT 'legacy_sections',
  ADD COLUMN IF NOT EXISTS base_agent_version_id text NOT NULL DEFAULT '';

-- requires-real-postgres-tail: canonical cohort identity remapping and CHECK replacement require PostgreSQL.

DROP TRIGGER IF EXISTS trg_cloud_evidence_usage_transition ON cloud_evolution_evidence_usage;
DROP TRIGGER IF EXISTS trg_cloud_cluster_claim_transition ON cloud_cluster_evidence_claims;

CREATE TEMP TABLE _janus_canonical_cohort_ids (
  old_id text PRIMARY KEY,
  target_id text NOT NULL UNIQUE
);

INSERT INTO _janus_canonical_cohort_ids(old_id,target_id)
SELECT id,'cohort_' || substr(encode(sha256(convert_to(cohort_key,'UTF8')),'hex'),1,32)
FROM cloud_agent_cohorts
WHERE cohort_key<>'' AND cohort_key NOT LIKE 'legacy:%';

UPDATE cloud_agent_cohort_members m SET cohort_id=x.target_id
FROM _janus_canonical_cohort_ids x WHERE m.cohort_id=x.old_id AND x.old_id<>x.target_id;
UPDATE cloud_cluster_evidence_claims c SET consumer_id=x.target_id
FROM _janus_canonical_cohort_ids x WHERE c.consumer_id=x.old_id AND x.old_id<>x.target_id;
UPDATE cloud_evolution_evidence_usage u SET consumer_id=x.target_id
FROM _janus_canonical_cohort_ids x
WHERE u.evolution_scope='cluster' AND u.consumer_id=x.old_id AND x.old_id<>x.target_id;
UPDATE cloud_evolution_runs r SET cohort_id=x.target_id,consumer_id=x.target_id
FROM _janus_canonical_cohort_ids x WHERE r.cohort_id=x.old_id AND x.old_id<>x.target_id;
UPDATE cloud_market_agent_candidates c SET cohort_id=x.target_id
FROM _janus_canonical_cohort_ids x WHERE c.cohort_id=x.old_id AND x.old_id<>x.target_id;
UPDATE cloud_evolution_run_snapshots s SET cohort_snapshot_json=(s.cohort_snapshot_json - 'algorithmVersion') ||
  jsonb_build_object('cohortId',x.target_id)
FROM cloud_evolution_runs r JOIN _janus_canonical_cohort_ids x ON r.cohort_id=x.target_id
WHERE s.run_id=r.id;
UPDATE cloud_agent_cohorts c SET id=x.target_id,payload_json=(c.payload_json - 'algorithmVersion') || jsonb_build_object('id',x.target_id)
FROM _janus_canonical_cohort_ids x WHERE c.id=x.old_id AND x.old_id<>x.target_id;
UPDATE cloud_agent_cohorts SET payload_json=payload_json-'algorithmVersion';

DROP TABLE _janus_canonical_cohort_ids;

CREATE TRIGGER trg_cloud_evidence_usage_transition
BEFORE INSERT OR UPDATE ON cloud_evolution_evidence_usage
FOR EACH ROW EXECUTE FUNCTION janus_guard_evolution_evidence_usage_transition();
CREATE TRIGGER trg_cloud_cluster_claim_transition
BEFORE INSERT OR UPDATE ON cloud_cluster_evidence_claims
FOR EACH ROW EXECUTE FUNCTION janus_guard_cluster_evidence_claim_transition();

UPDATE cloud_market_agent_candidates c SET
  status=CASE
    WHEN c.status='canary' AND EXISTS (
      SELECT 1 FROM cloud_market_evaluations e WHERE e.candidate_id=c.id
        AND e.evaluation_kind='async_shadow_canary'
    ) AND NOT EXISTS (
      SELECT 1 FROM cloud_market_evaluations e WHERE e.candidate_id=c.id
        AND e.evaluation_kind='async_shadow_canary'
        AND (e.regression OR e.privacy_violation OR e.role_violation)
    ) THEN 'shadow_passed'
    WHEN c.status='canary' THEN 'governance_approved'
    WHEN c.status='rejected' THEN 'regression_rejected'
    ELSE c.status
  END,
  shadow_started_at=COALESCE(shadow_started_at,canary_started_at),
  shadow_completed_at=CASE WHEN c.status='canary' AND EXISTS (
    SELECT 1 FROM cloud_market_evaluations e WHERE e.candidate_id=c.id AND e.evaluation_kind='async_shadow_canary'
  ) THEN COALESCE(shadow_completed_at,updated_at) ELSE shadow_completed_at END;

UPDATE cloud_market_candidate_family_sections s SET status=c.status
FROM cloud_market_agent_candidates c WHERE c.id=s.candidate_id;

UPDATE cloud_evolution_runs SET status='proposed' WHERE evolution_scope='cluster' AND status='canary';
UPDATE cloud_evolution_jobs j SET job_kind='cluster_shadow',status='queued'
FROM cloud_market_agent_candidates c
WHERE c.run_id=j.run_id AND c.status='governance_approved' AND j.job_kind='cluster_canary';
UPDATE cloud_evolution_jobs j SET job_kind='cluster_canary',status='waiting_canary',claimed_by='',lease_expires_at=NULL
FROM cloud_market_agent_candidates c
WHERE c.run_id=j.run_id AND c.status='shadow_passed';
UPDATE cloud_evolution_evidence_usage u SET lease_expires_at=NULL
FROM cloud_evolution_runs r JOIN cloud_market_agent_candidates c ON c.run_id=r.id
WHERE u.run_id=r.id AND u.evolution_scope='cluster' AND u.status='reserved' AND c.status='shadow_passed';

ALTER TABLE cloud_evolution_jobs DROP CONSTRAINT IF EXISTS chk_cloud_evolution_job_kind;
ALTER TABLE cloud_evolution_jobs ADD CONSTRAINT chk_cloud_evolution_job_kind CHECK(job_kind IN
  ('personal_evolution','cluster_evolution','cluster_shadow','cluster_canary','market_health'));
ALTER TABLE cloud_evolution_jobs DROP CONSTRAINT IF EXISTS chk_cloud_evolution_job_status;
ALTER TABLE cloud_evolution_jobs ADD CONSTRAINT chk_cloud_evolution_job_status CHECK(status IN
  ('queued','claimed','running','waiting_canary','completed','failed_retryable','failed_terminal','cancelled'));

ALTER TABLE cloud_market_agent_candidates DROP CONSTRAINT IF EXISTS chk_cloud_market_candidate_status;
ALTER TABLE cloud_market_agent_candidates ADD CONSTRAINT chk_cloud_market_candidate_status CHECK(status IN
  ('draft','gated','governance_approved','shadow_passed','canary_running','canary_passed','released',
   'gate_rejected','governance_rejected','regression_rejected','privacy_rejected','canary_rejected','rolled_back','archived'));
ALTER TABLE cloud_market_agent_versions DROP CONSTRAINT IF EXISTS chk_cloud_market_version_status;
ALTER TABLE cloud_market_agent_versions ADD CONSTRAINT chk_cloud_market_version_status CHECK(status IN
  ('draft','released','suspended','rolled_back','rejected','archived'));
ALTER TABLE cloud_market_agent_versions DROP CONSTRAINT IF EXISTS chk_cloud_market_version_kind;
ALTER TABLE cloud_market_agent_versions ADD CONSTRAINT chk_cloud_market_version_kind CHECK(version_kind IN ('market_base','legacy_sections'));

DROP INDEX IF EXISTS idx_cloud_evolution_active_cluster_run;
CREATE UNIQUE INDEX idx_cloud_evolution_active_cluster_run ON cloud_evolution_runs(cohort_id)
  WHERE evolution_scope='cluster' AND status IN ('queued','claimed','running','proposed','canary');
