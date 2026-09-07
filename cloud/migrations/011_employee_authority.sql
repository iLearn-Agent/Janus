ALTER TABLE cloud_agent_families_v3 ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE cloud_agent_families_v3 ADD COLUMN IF NOT EXISTS routable boolean NOT NULL DEFAULT false;
ALTER TABLE cloud_agent_families_v3 ADD COLUMN IF NOT EXISTS current_version_id text NOT NULL DEFAULT '';
ALTER TABLE cloud_agent_families_v3 ADD COLUMN IF NOT EXISTS instance_kind text NOT NULL DEFAULT 'unavailable';
ALTER TABLE cloud_agent_families_v3 ADD COLUMN IF NOT EXISTS recruitable boolean NOT NULL DEFAULT false;
ALTER TABLE cloud_agent_families_v3 ADD COLUMN IF NOT EXISTS default_for_new_user boolean NOT NULL DEFAULT false;
ALTER TABLE cloud_agent_families_v3 ADD COLUMN IF NOT EXISTS quota_cost integer NOT NULL DEFAULT 0;

ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN IF NOT EXISTS instance_kind text NOT NULL DEFAULT 'employee';
ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN IF NOT EXISTS employment_state text NOT NULL DEFAULT 'active';
ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN IF NOT EXISTS quota_exempt boolean NOT NULL DEFAULT false;
ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN IF NOT EXISTS recruited_at timestamptz;
ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;
ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN IF NOT EXISTS last_state_changed_at timestamptz;
ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN IF NOT EXISTS state_revision integer NOT NULL DEFAULT 1;
ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN IF NOT EXISTS recruitment_source text NOT NULL DEFAULT 'migration';
ALTER TABLE cloud_user_agent_instances_v3 ADD COLUMN IF NOT EXISTS policy_version text NOT NULL DEFAULT 'employee_cloud_authority_v1';

CREATE TABLE IF NOT EXISTS cloud_user_agent_recruitment_events (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL DEFAULT '',
  agent_family_id text NOT NULL,
  event_type text NOT NULL,
  previous_state text NOT NULL DEFAULT '',
  next_state text NOT NULL DEFAULT '',
  quota_before integer NOT NULL DEFAULT 0,
  quota_after integer NOT NULL DEFAULT 0,
  command_id text NOT NULL,
  source_device_id text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,command_id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_recruitment_events_user ON cloud_user_agent_recruitment_events(user_id,created_at);

CREATE TABLE IF NOT EXISTS cloud_user_agent_instance_aliases_v3 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias_instance_id text NOT NULL,
  canonical_instance_id text NOT NULL,
  reason text NOT NULL DEFAULT 'cross_device_family_conflict',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,alias_instance_id)
);

UPDATE cloud_agent_families_v3 SET
  instance_kind = CASE
    WHEN id = 'secretary_agent' THEN 'system'
    WHEN role IN ('hr','department_leader') THEN 'governance'
    WHEN status NOT IN ('disabled','retired','archived') AND routable THEN 'employee'
    ELSE 'unavailable'
  END,
  recruitable = CASE
    WHEN id != 'secretary_agent' AND role NOT IN ('hr','department_leader')
      AND status NOT IN ('disabled','retired','archived') AND routable THEN true ELSE false END,
  default_for_new_user = CASE WHEN id = 'general_agent' AND status NOT IN ('disabled','retired','archived') THEN true ELSE false END,
  quota_cost = CASE
    WHEN id != 'secretary_agent' AND role NOT IN ('hr','department_leader')
      AND status NOT IN ('disabled','retired','archived') AND routable THEN 1 ELSE 0 END;

UPDATE cloud_user_agent_instances_v3 SET
  employment_state = CASE WHEN status = 'inactive' THEN 'inactive' ELSE 'active' END,
  recruited_at = COALESCE(recruited_at,created_at),
  last_state_changed_at = COALESCE(last_state_changed_at,updated_at),
  recruitment_source = CASE WHEN recruitment_source IN ('','migration') THEN 'migration' ELSE recruitment_source END;

UPDATE cloud_user_agent_instances_v3 SET instance_kind='unavailable',quota_exempt=true;
UPDATE cloud_user_agent_instances_v3 SET instance_kind='system',quota_exempt=true
  WHERE agent_family_id IN (SELECT id FROM cloud_agent_families_v3 WHERE instance_kind='system');
UPDATE cloud_user_agent_instances_v3 SET instance_kind='governance',quota_exempt=true
  WHERE agent_family_id IN (SELECT id FROM cloud_agent_families_v3 WHERE instance_kind='governance');
UPDATE cloud_user_agent_instances_v3 SET instance_kind='employee',quota_exempt=false
  WHERE agent_family_id IN (SELECT id FROM cloud_agent_families_v3 WHERE instance_kind='employee');
