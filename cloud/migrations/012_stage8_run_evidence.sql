CREATE TABLE IF NOT EXISTS cloud_cluster_run_evidence (
  run_id text NOT NULL REFERENCES cloud_evolution_runs(id) ON DELETE CASCADE,
  evidence_id text NOT NULL REFERENCES cloud_evolution_evidence(evidence_id) ON DELETE CASCADE,
  raw_weight double precision NOT NULL DEFAULT 0,
  effective_weight double precision NOT NULL DEFAULT 0,
  cohort_raw_total double precision NOT NULL DEFAULT 0,
  user_cap double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id,evidence_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_evolution_active_cluster_run
  ON cloud_evolution_runs(cohort_id)
  WHERE evolution_scope = 'cluster' AND status IN ('queued','claimed','running','proposed');
