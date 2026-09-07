CREATE TABLE IF NOT EXISTS cloud_evolution_key_rotation_jobs (
  evidence_id text NOT NULL REFERENCES cloud_evolution_evidence(evidence_id) ON DELETE CASCADE,
  target_key_id text NOT NULL,
  source_key_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','completed','failed_retryable','quarantined')),
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text NOT NULL DEFAULT '',
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  error_code text NOT NULL DEFAULT '',
  error_text text NOT NULL DEFAULT '',
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(evidence_id,target_key_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_evolution_key_rotation_due
  ON cloud_evolution_key_rotation_jobs(status,available_at,evidence_id);

-- requires-real-postgres-tail: role grants are rehearsed on PostgreSQL and are unsupported by pg-mem.
GRANT SELECT,INSERT,UPDATE ON cloud_evolution_key_rotation_jobs TO janus_evolution_worker;
GRANT SELECT ON cloud_evolution_key_rotation_jobs TO janus_api;
