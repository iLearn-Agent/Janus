ALTER TABLE cloud_evolution_evidence
  ADD COLUMN IF NOT EXISTS lineage_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'validated',
  ADD COLUMN IF NOT EXISTS validation_policy_version text NOT NULL DEFAULT 'legacy_backfill_v1',
  ADD COLUMN IF NOT EXISTS validation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS historical_inactive boolean NOT NULL DEFAULT false;

UPDATE cloud_evolution_evidence SET
  lineage_key=CASE
    WHEN lineage_key<>'' THEN lineage_key
    WHEN source_kind='conversation_segment' THEN 'conversation:' || source_id || ':' || source_version_id
    ELSE source_kind || ':' || source_id || ':' || source_version_id
  END,
  validation_status=CASE WHEN quarantine_reason='' THEN 'validated' ELSE 'quarantined' END,
  validation_policy_version=CASE WHEN validation_policy_version='' THEN 'legacy_backfill_v1' ELSE validation_policy_version END,
  validated_at=CASE WHEN quarantine_reason='' THEN COALESCE(validated_at,ingested_at) ELSE validated_at END;

ALTER TABLE cloud_evolution_evidence DROP CONSTRAINT IF EXISTS chk_cloud_evolution_evidence_validation_status;
ALTER TABLE cloud_evolution_evidence ADD CONSTRAINT chk_cloud_evolution_evidence_validation_status CHECK(validation_status IN
  ('pending_validation','validated','quarantined','failed_retryable'));

CREATE INDEX IF NOT EXISTS idx_cloud_evidence_validation
  ON cloud_evolution_evidence(validation_status,ingested_at,evidence_id);
CREATE INDEX IF NOT EXISTS idx_cloud_evidence_lineage
  ON cloud_evolution_evidence(owner_user_id,user_agent_instance_id,lineage_key,occurred_at,evidence_id);

CREATE TABLE IF NOT EXISTS cloud_evolution_evidence_validation_jobs (
  evidence_id text PRIMARY KEY REFERENCES cloud_evolution_evidence(evidence_id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text NOT NULL DEFAULT '',
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  error_code text NOT NULL DEFAULT '',
  error_text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT chk_cloud_evidence_validation_job_status CHECK(status IN
    ('queued','claimed','completed','failed_retryable','failed_terminal','quarantined'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_evidence_validation_jobs_claim
  ON cloud_evolution_evidence_validation_jobs(status,available_at,lease_expires_at);

CREATE TABLE IF NOT EXISTS cloud_evolution_evidence_quarantine (
  id text PRIMARY KEY,
  evidence_id text NOT NULL DEFAULT '',
  owner_user_id text NOT NULL DEFAULT '',
  user_agent_instance_id text NOT NULL DEFAULT '',
  source_kind text NOT NULL DEFAULT '',
  source_id text NOT NULL DEFAULT '',
  source_version_id text NOT NULL DEFAULT '',
  reason_code text NOT NULL,
  reason_text text NOT NULL DEFAULT '',
  retryable boolean NOT NULL DEFAULT false,
  resolution_status text NOT NULL DEFAULT 'pending',
  resolution_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT chk_cloud_evidence_quarantine_resolution CHECK(resolution_status IN ('pending','released','rejected','resolved'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_evidence_quarantine_subject
  ON cloud_evolution_evidence_quarantine(owner_user_id,resolution_status,created_at,id);
