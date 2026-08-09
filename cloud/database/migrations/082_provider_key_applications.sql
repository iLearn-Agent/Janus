CREATE TABLE IF NOT EXISTS provider_key_applications (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_email text NOT NULL,
  organization text NOT NULL,
  usage text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','claimed','rejected','revoked')),
  decision_note text NOT NULL DEFAULT '',
  reviewed_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  grant_expires_at timestamptz,
  claimed_at timestamptz,
  admin_notified_at timestamptz,
  decision_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_key_applications_review
  ON provider_key_applications(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_provider_key_applications_user
  ON provider_key_applications(user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_key_applications_one_active_user
  ON provider_key_applications(user_id)
  WHERE status IN ('pending','approved','claimed');
