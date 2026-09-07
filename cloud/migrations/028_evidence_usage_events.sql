CREATE TABLE IF NOT EXISTS cloud_evolution_evidence_usage_events (
  id text PRIMARY KEY,
  evidence_id text NOT NULL REFERENCES cloud_evolution_evidence(evidence_id) ON DELETE CASCADE,
  evolution_scope text NOT NULL CHECK(evolution_scope IN ('personal','cluster')),
  consumer_id text NOT NULL,
  from_status text NOT NULL DEFAULT '',
  to_status text NOT NULL CHECK(to_status IN ('available','reserved','consumed','evaluated_rejected','released')),
  run_id text NOT NULL DEFAULT '',
  algorithm_version text NOT NULL DEFAULT '',
  rejection_kind text NOT NULL DEFAULT '',
  transition_reason text NOT NULL DEFAULT '',
  re_evaluation_basis_hash text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_evolution_usage_events_subject
  ON cloud_evolution_evidence_usage_events(evolution_scope,consumer_id,occurred_at,id);

-- requires-real-postgres-tail: md5-based legacy backfill is rehearsed on PostgreSQL.
INSERT INTO cloud_evolution_evidence_usage_events (
  id,evidence_id,evolution_scope,consumer_id,from_status,to_status,run_id,algorithm_version,
  rejection_kind,transition_reason,re_evaluation_basis_hash,occurred_at
)
SELECT 'usage_event_legacy_' || md5(evidence_id || E'\n' || evolution_scope || E'\n' || consumer_id),
  evidence_id,evolution_scope,consumer_id,'',status,run_id,algorithm_version,rejection_kind,
  CASE WHEN transition_reason='' THEN 'legacy_snapshot' ELSE transition_reason END,re_evaluation_basis_hash,updated_at
FROM cloud_evolution_evidence_usage
ON CONFLICT(id) DO NOTHING;
