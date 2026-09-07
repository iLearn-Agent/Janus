-- Sync V6 entities carry an Account Workspace identity. These base tables are
-- declared here so the sync service remains self-contained on fresh installs;
-- migration 062 backfills organizations and adds synchronization triggers.
CREATE TABLE IF NOT EXISTS account_workspaces (
  id text PRIMARY KEY,
  workspace_kind text NOT NULL CHECK (workspace_kind IN ('personal','organization')),
  organization_id text NOT NULL DEFAULT '',
  owner_user_id text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  avatar_url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_workspace_memberships (
  workspace_id text NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member','guest')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','left','removed','suspended')),
  display_name text NOT NULL DEFAULT '',
  avatar_url text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,user_id)
);

ALTER TABLE cloud_task_runs
  ADD COLUMN IF NOT EXISTS account_workspace_id text NOT NULL DEFAULT 'workspace_personal';

CREATE TABLE IF NOT EXISTS cloud_devices_v6 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  hostname text NOT NULL DEFAULT '',
  platform text NOT NULL DEFAULT '',
  arch text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','revoked')),
  public_key_pem text NOT NULL DEFAULT '',
  public_key_fingerprint text NOT NULL DEFAULT '',
  approved_by_device_id text NOT NULL DEFAULT '',
  approved_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_devices_v6_user_status
  ON cloud_devices_v6(user_id, status, updated_at);

CREATE TABLE IF NOT EXISTS cloud_device_token_nonces_v6 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  nonce text NOT NULL,
  proof_timestamp timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, device_id, nonce)
);

ALTER TABLE cloud_sync_grants ADD COLUMN IF NOT EXISTS grant_version integer NOT NULL DEFAULT 6;
ALTER TABLE cloud_sync_grants ADD COLUMN IF NOT EXISTS issued_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE cloud_sync_grants ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

INSERT INTO cloud_devices_v6 (
  user_id, device_id, display_name, status, approved_by_device_id, approved_at, revoked_at, created_at, updated_at
)
SELECT user_id, device_id, device_id,
  CASE WHEN status = 'revoked' THEN 'revoked' ELSE 'approved' END,
  'legacy_migration',
  CASE WHEN status = 'revoked' THEN NULL ELSE created_at END,
  CASE WHEN status = 'revoked' THEN updated_at ELSE NULL END,
  created_at, updated_at
FROM cloud_sync_grants
ON CONFLICT(user_id, device_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS cloud_sync_batches_v6 (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  client_cursor text NOT NULL DEFAULT '',
  accepted_cursor text NOT NULL DEFAULT '',
  item_count integer NOT NULL DEFAULT 0,
  conflict_count integer NOT NULL DEFAULT 0,
  payload_hash text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'accepted',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, device_id, payload_hash)
);

CREATE TABLE IF NOT EXISTS cloud_sync_entities_v6 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  deleted boolean NOT NULL DEFAULT false,
  content_hash text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  origin_device_id text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_entities_v6_changed
  ON cloud_sync_entities_v6(user_id, updated_at, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS cloud_memory_document_aliases_v3 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias_document_id text NOT NULL,
  canonical_document_id text NOT NULL,
  reason text NOT NULL DEFAULT 'cross_device_memory_conflict',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, alias_document_id)
);

CREATE TABLE IF NOT EXISTS cloud_sync_changes_v6 (
  sequence_id bigserial PRIMARY KEY,
  change_id text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  batch_id text NOT NULL REFERENCES cloud_sync_batches_v6(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('upsert','delete')),
  base_revision bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL,
  content_hash text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_changes_v6_cursor
  ON cloud_sync_changes_v6(user_id, sequence_id);

CREATE TABLE IF NOT EXISTS cloud_sync_conflicts_v6 (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  batch_id text NOT NULL DEFAULT '',
  change_id text NOT NULL DEFAULT '',
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  conflict_kind text NOT NULL,
  server_revision bigint NOT NULL DEFAULT 0,
  client_base_revision bigint NOT NULL DEFAULT 0,
  server_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'preserved',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS cloud_projects_v6 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, id)
);

CREATE TABLE IF NOT EXISTS cloud_conversations_v6 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, id)
);

CREATE TABLE IF NOT EXISTS cloud_messages_v6 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, id)
);

CREATE TABLE IF NOT EXISTS cloud_model_executions_v6 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, id)
);

CREATE TABLE IF NOT EXISTS cloud_file_refs_v6 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, id)
);

CREATE TABLE IF NOT EXISTS cloud_file_objects_v6 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256 text NOT NULL,
  object_key text NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0,
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  storage_status text NOT NULL DEFAULT 'pending' CHECK (storage_status IN ('pending','uploaded','verified','failed','deleted')),
  reference_count bigint NOT NULL DEFAULT 0,
  checksum_verified boolean NOT NULL DEFAULT false,
  upload_expires_at timestamptz,
  unreferenced_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, sha256),
  UNIQUE(object_key)
);

CREATE INDEX IF NOT EXISTS idx_cloud_file_objects_v6_cleanup
  ON cloud_file_objects_v6(storage_status, unreferenced_at);

ALTER TABLE cloud_task_security_contexts_v5
  ADD COLUMN IF NOT EXISTS cloud_sync_recovery_allowed boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS cloud_task_key_device_envelopes_v6 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_run_id text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  device_id text NOT NULL,
  wrapping_algorithm text NOT NULL DEFAULT 'rsa-oaep-sha256',
  public_key_fingerprint text NOT NULL,
  wrapped_key text NOT NULL,
  source_cloud_key_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, task_run_id, key_version, device_id)
);

CREATE TABLE IF NOT EXISTS cloud_task_key_access_audits_v6 (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_run_id text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  requesting_device_id text NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL,
  reason_code text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_task_key_access_audits_v6_subject
  ON cloud_task_key_access_audits_v6(user_id, task_run_id, created_at);
