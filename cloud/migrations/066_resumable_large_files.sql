CREATE TABLE IF NOT EXISTS large_file_objects (
  id text PRIMARY KEY,
  account_workspace_id text NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_kind text NOT NULL,
  scope_id text NOT NULL,
  recipient_user_id text REFERENCES users(id) ON DELETE CASCADE,
  group_id text,
  delegation_id text,
  filename text NOT NULL DEFAULT 'file',
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  status text NOT NULL DEFAULT 'ready',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (scope_kind IN ('social', 'chat_group', 'collaboration_group', 'collaboration_task')),
  CHECK (size_bytes > 0),
  CHECK (status IN ('ready', 'unavailable'))
);

CREATE INDEX IF NOT EXISTS idx_large_file_objects_scope
  ON large_file_objects (scope_kind, scope_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_large_file_objects_workspace
  ON large_file_objects (account_workspace_id, owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS large_file_upload_sessions (
  id text PRIMARY KEY,
  file_id text NOT NULL,
  account_workspace_id text NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_kind text NOT NULL,
  scope_id text NOT NULL,
  recipient_user_id text REFERENCES users(id) ON DELETE CASCADE,
  group_id text,
  delegation_id text,
  filename text NOT NULL DEFAULT 'file',
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  chunk_size_bytes integer NOT NULL,
  chunk_count integer NOT NULL,
  storage_key text NOT NULL,
  status text NOT NULL DEFAULT 'uploading',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (scope_kind IN ('social', 'chat_group', 'collaboration_group', 'collaboration_task')),
  CHECK (size_bytes > 0),
  CHECK (chunk_size_bytes > 0),
  CHECK (chunk_count > 0),
  CHECK (status IN ('uploading', 'assembling', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_large_file_upload_sessions_owner_file
  ON large_file_upload_sessions (owner_user_id, file_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_large_file_upload_sessions_expiry
  ON large_file_upload_sessions (status, expires_at);

CREATE TABLE IF NOT EXISTS large_file_upload_chunks (
  upload_id text NOT NULL REFERENCES large_file_upload_sessions(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  size_bytes integer NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, chunk_index),
  CHECK (chunk_index >= 0),
  CHECK (size_bytes > 0)
);
