CREATE TABLE IF NOT EXISTS collaboration_files (
  id text PRIMARY KEY,
  delegation_id text NOT NULL REFERENCES agent_delegations(id) ON DELETE CASCADE,
  group_id text NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename text NOT NULL DEFAULT 'file',
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint NOT NULL DEFAULT 0,
  sha256 text NOT NULL DEFAULT '',
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delegation_id, owner_user_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_files_group
  ON collaboration_files (group_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_collaboration_files_delegation
  ON collaboration_files (delegation_id, created_at DESC);
