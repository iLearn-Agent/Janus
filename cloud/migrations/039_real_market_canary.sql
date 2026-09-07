CREATE TABLE IF NOT EXISTS cloud_market_canary_opt_ins (
  user_id text NOT NULL,
  user_agent_instance_id text NOT NULL,
  agent_family_id text NOT NULL,
  policy_version text NOT NULL DEFAULT 'market_canary_real_user_opt_in_v1',
  status text NOT NULL CHECK(status IN ('active','withdrawn')),
  command_id text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,user_agent_instance_id)
);

CREATE TABLE IF NOT EXISTS cloud_market_canary_assignments (
  candidate_id text NOT NULL REFERENCES cloud_market_agent_candidates(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  user_agent_instance_id text NOT NULL,
  agent_family_id text NOT NULL,
  policy_version text NOT NULL DEFAULT 'market_canary_real_user_opt_in_v1',
  status text NOT NULL CHECK(status IN ('enrolled','completed','withdrawn','rejected')),
  baseline_score double precision NOT NULL DEFAULT 0,
  baseline_failure_rate double precision NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(candidate_id,user_agent_instance_id)
);

CREATE TABLE IF NOT EXISTS cloud_market_canary_evaluations (
  id text PRIMARY KEY,
  candidate_id text NOT NULL UNIQUE REFERENCES cloud_market_agent_candidates(id) ON DELETE CASCADE,
  policy_version text NOT NULL DEFAULT 'market_canary_real_user_opt_in_v1',
  status text NOT NULL CHECK(status IN ('insufficient','approved','rejected')),
  user_count integer NOT NULL DEFAULT 0,
  case_count integer NOT NULL DEFAULT 0,
  baseline_score double precision NOT NULL DEFAULT 0,
  candidate_score double precision NOT NULL DEFAULT 0,
  baseline_failure_rate double precision NOT NULL DEFAULT 0,
  candidate_failure_rate double precision NOT NULL DEFAULT 0,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_market_canary_opt_ins_family
  ON cloud_market_canary_opt_ins(agent_family_id,status,updated_at);
CREATE INDEX IF NOT EXISTS idx_cloud_market_canary_assignments_instance
  ON cloud_market_canary_assignments(user_agent_instance_id,status,started_at);

-- requires-real-postgres-tail: role grants are not supported by pg-mem.
CREATE OR REPLACE FUNCTION janus_guard_released_market_version_content()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='released' AND (
    NEW.agent_family_id IS DISTINCT FROM OLD.agent_family_id OR
    NEW.parent_version_id IS DISTINCT FROM OLD.parent_version_id OR
    NEW.version_kind IS DISTINCT FROM OLD.version_kind OR
    NEW.base_agent_version_id IS DISTINCT FROM OLD.base_agent_version_id OR
    NEW.sections_json IS DISTINCT FROM OLD.sections_json OR
    NEW.health_baseline_json IS DISTINCT FROM OLD.health_baseline_json OR
    NEW.payload_json IS DISTINCT FROM OLD.payload_json
  ) THEN RAISE EXCEPTION 'released market version content is immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_cloud_market_version_content_immutable ON cloud_market_agent_versions;
CREATE TRIGGER trg_cloud_market_version_content_immutable
BEFORE UPDATE ON cloud_market_agent_versions FOR EACH ROW
EXECUTE FUNCTION janus_guard_released_market_version_content();

CREATE OR REPLACE FUNCTION janus_guard_released_market_section_content()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
  SELECT status INTO parent_status FROM cloud_market_agent_versions
    WHERE id=COALESCE(OLD.market_version_id,NEW.market_version_id);
  IF parent_status='released' THEN RAISE EXCEPTION 'released market version sections are immutable'; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
DROP TRIGGER IF EXISTS trg_cloud_market_section_update_immutable ON cloud_market_version_sections;
DROP TRIGGER IF EXISTS trg_cloud_market_section_delete_immutable ON cloud_market_version_sections;
CREATE TRIGGER trg_cloud_market_section_update_immutable BEFORE UPDATE ON cloud_market_version_sections
  FOR EACH ROW EXECUTE FUNCTION janus_guard_released_market_section_content();
CREATE TRIGGER trg_cloud_market_section_delete_immutable BEFORE DELETE ON cloud_market_version_sections
  FOR EACH ROW EXECUTE FUNCTION janus_guard_released_market_section_content();

GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_market_canary_opt_ins TO janus_api;
GRANT SELECT ON cloud_market_canary_assignments,cloud_market_canary_evaluations TO janus_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_market_canary_assignments,cloud_market_canary_evaluations TO janus_evolution_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_market_canary_opt_ins,cloud_market_canary_assignments,cloud_market_canary_evaluations TO janus_migrator;
