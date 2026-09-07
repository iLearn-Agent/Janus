CREATE TABLE IF NOT EXISTS cloud_employee_roster_states (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  roster_revision bigint NOT NULL DEFAULT 0,
  bootstrap_status text NOT NULL DEFAULT 'pending',
  bootstrap_id text NOT NULL DEFAULT '',
  policy_version text NOT NULL DEFAULT 'employee_cloud_authority_v1',
  bootstrapped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(roster_revision >= 0),
  CHECK(bootstrap_status IN ('pending','completed'))
);

INSERT INTO cloud_employee_roster_states(user_id,bootstrap_status,policy_version)
SELECT id,'pending','employee_cloud_authority_v1' FROM users
ON CONFLICT(user_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_cloud_employee_roster_bootstrap
  ON cloud_employee_roster_states(bootstrap_status,updated_at);
