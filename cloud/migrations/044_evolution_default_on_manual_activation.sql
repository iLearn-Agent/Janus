-- requires-real-postgres: compatibility upgrade; fresh pg-mem schemas already receive these defaults and tables from migration 008.
CREATE TABLE IF NOT EXISTS cloud_user_evolution_preferences (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  policy_version text NOT NULL DEFAULT 'evolution_default_on_account_pause_v1',
  state_revision bigint NOT NULL DEFAULT 1,
  last_command_id text NOT NULL DEFAULT '',
  paused_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(state_revision >= 1)
);

INSERT INTO cloud_user_evolution_preferences(user_id,enabled,policy_version)
SELECT id,true,'evolution_default_on_account_pause_v1' FROM users
ON CONFLICT(user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS cloud_personal_version_commands (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  command_id text NOT NULL,
  user_agent_instance_id text NOT NULL,
  action text NOT NULL,
  target_version_id text NOT NULL DEFAULT '',
  expected_active_version_id text NOT NULL DEFAULT '',
  previous_active_version_id text NOT NULL DEFAULT '',
  result_active_version_id text NOT NULL DEFAULT '',
  actor_device_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'confirmed',
  error_code text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY(user_id,command_id),
  CHECK(action IN ('activate','rollback')),
  CHECK(status IN ('confirmed','rejected'))
);

CREATE INDEX IF NOT EXISTS idx_cloud_personal_version_commands_instance
  ON cloud_personal_version_commands(user_id,user_agent_instance_id,created_at DESC);

ALTER TABLE cloud_user_agent_instances_v3
  ALTER COLUMN personal_evolution_consent SET DEFAULT true;

ALTER TABLE cloud_memory_documents_v3
  ALTER COLUMN allow_personal_evolution SET DEFAULT true;

UPDATE cloud_user_agent_instances_v3 SET
  personal_evolution_consent=(sync_enabled AND status='active'),
  cluster_contribution_consent=(sync_enabled AND status='active'),
  personal_skill_auto_activate=false;

UPDATE cloud_memory_documents_v3 d SET
  allow_personal_evolution=(i.sync_enabled AND i.status='active'),
  allow_cluster_evolution=(i.sync_enabled AND i.status='active'),
  sync_enabled=i.sync_enabled
FROM cloud_user_agent_instances_v3 i
WHERE i.user_id=d.user_id AND i.id=d.user_agent_instance_id;

-- requires-real-postgres-tail: named constraints and trigger functions are installed only by real PostgreSQL.
ALTER TABLE cloud_evolution_runs DROP CONSTRAINT IF EXISTS chk_cloud_evolution_run_status;
ALTER TABLE cloud_evolution_runs ADD CONSTRAINT chk_cloud_evolution_run_status CHECK(status IN
  ('queued','claimed','running','proposed','available','canary','applied','failed_retryable','failed_terminal',
   'evaluated_rejected','rolled_back','skipped','insufficient_evidence'));

CREATE OR REPLACE FUNCTION janus_set_cluster_participation_authority()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evolution_enabled boolean;
BEGIN
  SELECT p.enabled INTO evolution_enabled FROM cloud_user_evolution_preferences p WHERE p.user_id=NEW.user_id;
  evolution_enabled=COALESCE(evolution_enabled,true);
  NEW.personal_evolution_consent=(evolution_enabled AND NEW.sync_enabled AND NEW.status='active');
  NEW.cluster_contribution_consent=(evolution_enabled AND NEW.sync_enabled AND NEW.status='active');
  NEW.personal_skill_auto_activate=false;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_cloud_cluster_participation_authority ON cloud_user_agent_instances_v3;
CREATE TRIGGER trg_cloud_cluster_participation_authority
BEFORE INSERT OR UPDATE OF sync_enabled,status,personal_evolution_consent,cluster_contribution_consent,personal_skill_auto_activate
ON cloud_user_agent_instances_v3
FOR EACH ROW EXECUTE FUNCTION janus_set_cluster_participation_authority();

ALTER TABLE cloud_user_agent_instances_v3
  DROP CONSTRAINT IF EXISTS chk_cloud_cluster_participation_authority;
ALTER TABLE cloud_user_agent_instances_v3
  ADD CONSTRAINT chk_cloud_cluster_participation_authority CHECK(
    personal_evolution_consent=cluster_contribution_consent AND personal_skill_auto_activate=false
  );

GRANT SELECT,INSERT,UPDATE ON cloud_user_evolution_preferences TO janus_api;
GRANT SELECT,INSERT,UPDATE ON cloud_user_evolution_preferences TO janus_evolution_worker;
GRANT SELECT,INSERT ON cloud_personal_version_commands TO janus_api;
GRANT SELECT,INSERT ON cloud_personal_version_commands TO janus_evolution_worker;
