CREATE TABLE IF NOT EXISTS contact_organizations (
  id text PRIMARY KEY,
  organization_number text NOT NULL,
  name text NOT NULL,
  verification_code_salt text NOT NULL,
  verification_code_hash text NOT NULL,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_organizations_number_ci
  ON contact_organizations (lower(organization_number));

CREATE INDEX IF NOT EXISTS idx_contact_organizations_owner
  ON contact_organizations (owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS contact_organization_members (
  organization_id text NOT NULL REFERENCES contact_organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_organization_members_user
  ON contact_organization_members (user_id, updated_at DESC);
