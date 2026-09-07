ALTER TABLE cloud_evolution_evidence
  ADD COLUMN IF NOT EXISTS wrapped_data_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS key_wrap_algorithm text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS key_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS envelope_format text NOT NULL DEFAULT 'legacy_symmetric';

CREATE TABLE IF NOT EXISTS cloud_evolution_evidence_access_audits (
  id text PRIMARY KEY,
  worker_identity text NOT NULL,
  run_id text NOT NULL DEFAULT '',
  evidence_id text NOT NULL DEFAULT '',
  purpose text NOT NULL,
  result text NOT NULL,
  result_code text NOT NULL DEFAULT '',
  key_id text NOT NULL DEFAULT '',
  detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_cloud_evidence_access_result CHECK(result IN ('allowed','denied','failed'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_evidence_access_audit_subject
  ON cloud_evolution_evidence_access_audits(evidence_id,created_at,id);
CREATE INDEX IF NOT EXISTS idx_cloud_evidence_access_audit_run
  ON cloud_evolution_evidence_access_audits(run_id,created_at,id);

-- requires-real-postgres-tail: PostgreSQL roles, column privileges, and RLS are not supported by pg-mem.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='janus_api') THEN CREATE ROLE janus_api NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='janus_evolution_worker') THEN CREATE ROLE janus_evolution_worker NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='janus_migrator') THEN CREATE ROLE janus_migrator NOLOGIN; END IF;
END $$;

GRANT USAGE ON SCHEMA public TO janus_api,janus_evolution_worker,janus_migrator;
GRANT CREATE ON SCHEMA public TO janus_migrator;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO janus_api;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO janus_evolution_worker;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO janus_api;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO janus_evolution_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO janus_migrator;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO janus_migrator;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO janus_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE ON TABLES TO janus_evolution_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO janus_migrator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO janus_api,janus_evolution_worker,janus_migrator;

REVOKE ALL ON cloud_evolution_evidence FROM janus_api;
GRANT INSERT ON cloud_evolution_evidence TO janus_api;
GRANT SELECT (evidence_id,owner_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,source_version_id,
  context_space_id,task_id,delegation_id,content_hash,confidence,privacy_level,quarantine_reason,occurred_at,ingested_at,
  metadata_json,personal_threshold_eligible,eligibility_policy_version,lineage_key,validation_status,
  validation_policy_version,validation_json,validated_at,historical_inactive,encryption_algorithm,key_id,key_version,envelope_format)
  ON cloud_evolution_evidence TO janus_api;
GRANT INSERT,SELECT,UPDATE ON cloud_evolution_evidence_validation_jobs TO janus_api;
GRANT INSERT,SELECT ON cloud_evolution_evidence_quarantine TO janus_api;
GRANT SELECT,INSERT,UPDATE ON cloud_evolution_evidence_usage,cloud_evolution_evidence_usage_events TO janus_api;

REVOKE ALL ON cloud_evolution_evidence_access_audits FROM janus_api;

ALTER TABLE cloud_evolution_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_evolution_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cloud_evidence_api_metadata ON cloud_evolution_evidence;
DROP POLICY IF EXISTS cloud_evidence_worker_all ON cloud_evolution_evidence;
CREATE POLICY cloud_evidence_api_metadata ON cloud_evolution_evidence TO janus_api USING (true) WITH CHECK (true);
CREATE POLICY cloud_evidence_worker_all ON cloud_evolution_evidence TO janus_evolution_worker USING (true) WITH CHECK (true);
