-- requires-real-postgres: temporary-table/windowed reconciliation is rehearsed
-- against PostgreSQL; pg-mem does not implement the required planner semantics.
ALTER TABLE cloud_agent_cohorts
  ADD COLUMN IF NOT EXISTS cohort_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS identity_version text NOT NULL DEFAULT 'cluster_cohort_identity_v1';

UPDATE cloud_agent_cohorts
SET cohort_key=CASE
  WHEN COALESCE(payload_json->>'cohortKey','')<>'' THEN payload_json->>'cohortKey'
  WHEN agent_family_id<>'' THEN 'family:' || agent_family_id
  ELSE 'legacy:' || id
END
WHERE cohort_key='';

CREATE TEMP TABLE _janus_cohort_keepers(id text PRIMARY KEY);

INSERT INTO _janus_cohort_keepers(id)
SELECT candidate.id
FROM cloud_agent_cohorts candidate
LEFT JOIN cloud_agent_cohorts preferred ON preferred.cohort_key=candidate.cohort_key AND (
  CASE WHEN preferred.status='active' THEN 0 WHEN preferred.status='ineligible' THEN 1 ELSE 2 END
    < CASE WHEN candidate.status='active' THEN 0 WHEN candidate.status='ineligible' THEN 1 ELSE 2 END
  OR (
    CASE WHEN preferred.status='active' THEN 0 WHEN preferred.status='ineligible' THEN 1 ELSE 2 END
      = CASE WHEN candidate.status='active' THEN 0 WHEN candidate.status='ineligible' THEN 1 ELSE 2 END
    AND preferred.updated_at>candidate.updated_at
  )
  OR (
    CASE WHEN preferred.status='active' THEN 0 WHEN preferred.status='ineligible' THEN 1 ELSE 2 END
      = CASE WHEN candidate.status='active' THEN 0 WHEN candidate.status='ineligible' THEN 1 ELSE 2 END
    AND preferred.updated_at=candidate.updated_at AND preferred.id<candidate.id
  )
)
WHERE preferred.id IS NULL;

UPDATE cloud_agent_cohorts
SET cohort_key='legacy:' || id,status='inactive',updated_at=now()
WHERE id NOT IN (SELECT id FROM _janus_cohort_keepers);

DROP TABLE _janus_cohort_keepers;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_cohorts_key
  ON cloud_agent_cohorts(cohort_key);

ALTER TABLE cloud_evolution_run_snapshots
  ADD COLUMN IF NOT EXISTS cohort_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS cloud_cluster_evidence_claims (
  evidence_id text PRIMARY KEY REFERENCES cloud_evolution_evidence(evidence_id) ON DELETE CASCADE,
  consumer_id text NOT NULL,
  run_id text NOT NULL,
  claim_state text NOT NULL CHECK(claim_state IN ('reserved','consumed')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_cluster_claims_consumer
  ON cloud_cluster_evidence_claims(consumer_id,claim_state,updated_at);

INSERT INTO cloud_cluster_evidence_claims (
  evidence_id,consumer_id,run_id,claim_state,claimed_at,terminal_at,payload_json,updated_at
)
SELECT consumed.evidence_id,consumed.consumer_id,consumed.run_id,'consumed',
  COALESCE(consumed.reserved_at,consumed.updated_at),COALESCE(consumed.terminal_at,consumed.updated_at),
  '{"backfilled":true}'::jsonb,consumed.updated_at
FROM cloud_evolution_evidence_usage consumed
LEFT JOIN cloud_evolution_evidence_usage preferred ON preferred.evidence_id=consumed.evidence_id
  AND preferred.evolution_scope='cluster' AND preferred.status='consumed' AND (
    COALESCE(preferred.terminal_at,preferred.updated_at)<COALESCE(consumed.terminal_at,consumed.updated_at)
    OR (COALESCE(preferred.terminal_at,preferred.updated_at)=COALESCE(consumed.terminal_at,consumed.updated_at)
      AND preferred.updated_at<consumed.updated_at)
    OR (COALESCE(preferred.terminal_at,preferred.updated_at)=COALESCE(consumed.terminal_at,consumed.updated_at)
      AND preferred.updated_at=consumed.updated_at AND preferred.consumer_id<consumed.consumer_id)
  )
WHERE consumed.evolution_scope='cluster' AND consumed.status='consumed' AND preferred.evidence_id IS NULL
ON CONFLICT(evidence_id) DO NOTHING;

INSERT INTO cloud_cluster_evidence_claims (
  evidence_id,consumer_id,run_id,claim_state,claimed_at,payload_json,updated_at
)
SELECT reserved.evidence_id,reserved.consumer_id,reserved.run_id,'reserved',
  COALESCE(reserved.reserved_at,reserved.updated_at),'{"backfilled":true}'::jsonb,reserved.updated_at
FROM cloud_evolution_evidence_usage reserved
JOIN cloud_evolution_runs reserved_run ON reserved_run.id=reserved.run_id
JOIN cloud_evolution_jobs reserved_job ON reserved_job.run_id=reserved.run_id
LEFT JOIN (
  SELECT DISTINCT u.evidence_id,u.consumer_id,u.updated_at
  FROM cloud_evolution_evidence_usage u
  JOIN cloud_evolution_runs r ON r.id=u.run_id
  JOIN cloud_evolution_jobs j ON j.run_id=u.run_id
  WHERE u.evolution_scope='cluster' AND u.status='reserved'
    AND r.status IN ('queued','claimed','running','proposed')
    AND j.status IN ('queued','claimed','running','failed_retryable')
) preferred ON preferred.evidence_id=reserved.evidence_id AND (
  preferred.updated_at>reserved.updated_at
  OR (preferred.updated_at=reserved.updated_at AND preferred.consumer_id<reserved.consumer_id)
)
WHERE reserved.evolution_scope='cluster' AND reserved.status='reserved'
  AND reserved_run.status IN ('queued','claimed','running','proposed')
  AND reserved_job.status IN ('queued','claimed','running','failed_retryable')
  AND preferred.evidence_id IS NULL
ON CONFLICT(evidence_id) DO NOTHING;

UPDATE cloud_evolution_evidence_usage
SET status='released',run_id='',rejection_kind='',transition_reason='legacy_cohort_reconciliation',
  lease_expires_at=NULL,terminal_at=NULL,updated_at=now()
WHERE evolution_scope='cluster' AND status='reserved'
  AND evidence_id || '|' || run_id NOT IN (
    SELECT evidence_id || '|' || run_id FROM cloud_cluster_evidence_claims WHERE claim_state='reserved'
  );
