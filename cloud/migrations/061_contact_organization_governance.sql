CREATE TABLE IF NOT EXISTS contact_organization_exit_requests (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES contact_organizations(id) ON DELETE CASCADE,
  requester_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_role text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'pending',
  resolved_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_organization_exit_requests_pending
  ON contact_organization_exit_requests (organization_id, requester_user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_contact_organization_exit_requests_org
  ON contact_organization_exit_requests (organization_id, status, created_at);

CREATE TABLE IF NOT EXISTS contact_organization_notices (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id text,
  organization_name text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT 'info',
  title text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_organization_notices_user
  ON contact_organization_notices (user_id, read_at, created_at DESC);
