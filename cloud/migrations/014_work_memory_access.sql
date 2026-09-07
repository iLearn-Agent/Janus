CREATE TABLE IF NOT EXISTS cloud_work_scopes (
  id text PRIMARY KEY,
  federation_type text NOT NULL,
  federation_id text NOT NULL,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  revision_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(federation_type, federation_id)
);

CREATE TABLE IF NOT EXISTS cloud_work_participants (
  work_scope_id text NOT NULL REFERENCES cloud_work_scopes(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_instance_id text NOT NULL,
  agent_family_id text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'executor',
  collaboration_edges_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(work_scope_id, user_id, agent_instance_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_work_participants_scope_status
  ON cloud_work_participants(work_scope_id, status, user_id, agent_instance_id);

CREATE TABLE IF NOT EXISTS cloud_leadership_assignments (
  id text PRIMARY KEY,
  work_scope_id text NOT NULL REFERENCES cloud_work_scopes(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_instance_id text NOT NULL,
  role text NOT NULL,
  leadership_level_snapshot text NOT NULL DEFAULT '',
  permission_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  appointed_by_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_leadership_scope_agent
  ON cloud_leadership_assignments(work_scope_id, user_id, agent_instance_id, status, valid_from, valid_until);

CREATE TABLE IF NOT EXISTS cloud_work_memory_versions (
  id text PRIMARY KEY,
  work_scope_id text NOT NULL REFERENCES cloud_work_scopes(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_instance_id text NOT NULL,
  memory_document_id text NOT NULL,
  memory_document_version_id text NOT NULL,
  version_no integer NOT NULL DEFAULT 1,
  visibility text NOT NULL,
  content_hash text NOT NULL DEFAULT '',
  source_cursor text NOT NULL DEFAULT '',
  encryption_algorithm text NOT NULL,
  encryption_key_version integer NOT NULL DEFAULT 1,
  content_ciphertext text NOT NULL,
  content_nonce text NOT NULL,
  content_tag text NOT NULL,
  content_aad text NOT NULL DEFAULT '',
  cloud_wrap_algorithm text NOT NULL,
  cloud_wrapping_key_id text NOT NULL,
  cloud_wrapped_key text NOT NULL,
  published_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id, memory_document_version_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_work_memory_scope_target
  ON cloud_work_memory_versions(work_scope_id, agent_instance_id, published_at DESC);

CREATE TABLE IF NOT EXISTS cloud_work_memory_access_audits (
  id text PRIMARY KEY,
  requester_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_agent_instance_id text NOT NULL DEFAULT '',
  target_user_id text NOT NULL DEFAULT '',
  target_agent_instance_id text NOT NULL DEFAULT '',
  work_scope_id text NOT NULL DEFAULT '',
  memory_document_version_id text NOT NULL DEFAULT '',
  requested_reason text NOT NULL DEFAULT '',
  requester_role_snapshot text NOT NULL DEFAULT '',
  leadership_assignment_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  result text NOT NULL,
  result_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_work_memory_audits_scope_created
  ON cloud_work_memory_access_audits(work_scope_id, created_at DESC);
