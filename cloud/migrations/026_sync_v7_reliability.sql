CREATE TABLE IF NOT EXISTS cloud_sync_snapshots_v7 (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  snapshot_cursor bigint NOT NULL DEFAULT 0,
  entity_count integer NOT NULL DEFAULT 0,
  entities_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_sync_compaction_states_v7 (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  compacted_through bigint NOT NULL DEFAULT 0,
  last_snapshot_cursor bigint NOT NULL DEFAULT 0,
  last_compacted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_sync_device_cursors_v7 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  last_cursor bigint NOT NULL DEFAULT 0,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  reset_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, device_id)
);

CREATE TABLE IF NOT EXISTS cloud_sync_rate_limits_v7 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  operation text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, device_id, operation)
);

CREATE TABLE IF NOT EXISTS cloud_sync_usage_v7 (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  verified_storage_bytes bigint NOT NULL DEFAULT 0,
  pending_storage_bytes bigint NOT NULL DEFAULT 0,
  last_change_cursor bigint NOT NULL DEFAULT 0,
  change_count bigint NOT NULL DEFAULT 0,
  conflict_count bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_device_cursors_v7_seen
  ON cloud_sync_device_cursors_v7(user_id, last_seen_at);
