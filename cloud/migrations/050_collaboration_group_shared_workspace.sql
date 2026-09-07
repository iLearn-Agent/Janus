CREATE TABLE IF NOT EXISTS collaboration_group_workspaces (
  group_id text PRIMARY KEY REFERENCES collaboration_groups(id) ON DELETE CASCADE,
  workspace_epoch text NOT NULL DEFAULT '',
  revision bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collaboration_group_workspace_files (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
  relative_path text NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename text NOT NULL DEFAULT 'file',
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint NOT NULL DEFAULT 0,
  sha256 text NOT NULL DEFAULT '',
  data bytea NOT NULL DEFAULT ''::bytea,
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_group_workspace_files_revision
  ON collaboration_group_workspace_files (group_id, revision ASC);

INSERT INTO collaboration_group_workspaces (group_id, workspace_epoch, revision, status, updated_at)
SELECT id, 'workspace_' || id, 0, status, updated_at
FROM collaboration_groups
ON CONFLICT (group_id) DO NOTHING;

INSERT INTO collaboration_group_workspace_files (
  id, group_id, relative_path, revision, owner_user_id, filename,
  content_type, size_bytes, sha256, data, deleted, created_at, updated_at
)
SELECT
  'group_workspace_' || id,
  group_id,
  'published/' || id || '-' || filename,
  1,
  owner_user_id,
  filename,
  content_type,
  size_bytes,
  sha256,
  data,
  false,
  created_at,
  updated_at
FROM collaboration_files
ON CONFLICT (group_id, relative_path) DO NOTHING;

UPDATE collaboration_group_workspaces
SET revision = 1
WHERE group_id IN (SELECT DISTINCT group_id FROM collaboration_group_workspace_files);
