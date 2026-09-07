CREATE TABLE IF NOT EXISTS social_message_files (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id text REFERENCES users(id) ON DELETE CASCADE,
  group_id text REFERENCES collaboration_groups(id) ON DELETE CASCADE,
  filename text NOT NULL DEFAULT 'file',
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint NOT NULL DEFAULT 0,
  sha256 text NOT NULL DEFAULT '',
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((recipient_user_id IS NOT NULL AND group_id IS NULL) OR (recipient_user_id IS NULL AND group_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_social_message_files_direct
  ON social_message_files (owner_user_id, recipient_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_social_message_files_group
  ON social_message_files (group_id, created_at DESC);
