CREATE TABLE IF NOT EXISTS chat_group_message_files (
  id text PRIMARY KEY,
  account_workspace_id text NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id text NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  filename text NOT NULL DEFAULT 'file',
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint NOT NULL DEFAULT 0,
  sha256 text NOT NULL DEFAULT '',
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (size_bytes >= 0)
);

CREATE INDEX IF NOT EXISTS idx_chat_group_message_files_group
  ON chat_group_message_files (group_id, created_at DESC);
