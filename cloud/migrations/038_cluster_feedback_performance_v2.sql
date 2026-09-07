ALTER TABLE cloud_agent_performance_events
  ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'legacy_client',
  ADD COLUMN IF NOT EXISTS source_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source_version_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS authority text NOT NULL DEFAULT 'legacy_client',
  ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'legacy';

UPDATE cloud_agent_performance_events SET
  source_kind=CASE WHEN source_kind='' THEN 'legacy_client' ELSE source_kind END,
  authority=CASE WHEN authority='' THEN 'legacy_client' ELSE authority END,
  validation_status=CASE WHEN validation_status='' THEN 'legacy' ELSE validation_status END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_performance_authoritative_source
  ON cloud_agent_performance_events(owner_user_id,user_agent_instance_id,source_kind,source_id,source_version_id)
  WHERE source_id<>'' AND validation_status='validated';
CREATE INDEX IF NOT EXISTS idx_cloud_performance_authoritative_window
  ON cloud_agent_performance_events(user_agent_instance_id,authority,validation_status,occurred_at);
CREATE INDEX IF NOT EXISTS idx_cloud_performance_peer_baseline
  ON cloud_agent_performance_events(task_type_key,agent_family_id,authority,validation_status,occurred_at);

CREATE TABLE IF NOT EXISTS cloud_performance_backfill_cursors (
  cursor_key text PRIMARY KEY,
  last_updated_at timestamptz,
  last_source_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO cloud_performance_backfill_cursors(cursor_key,status)
VALUES('task_nodes','active') ON CONFLICT(cursor_key) DO NOTHING;

-- requires-real-postgres-tail: named CHECK constraints are installed only by real PostgreSQL.
ALTER TABLE cloud_agent_performance_events DROP CONSTRAINT IF EXISTS chk_cloud_performance_event_authority_v2;
ALTER TABLE cloud_agent_performance_events ADD CONSTRAINT chk_cloud_performance_event_authority_v2 CHECK(
  authority IN ('cloud','legacy_client') AND validation_status IN ('validated','deferred','rejected','legacy')
);
ALTER TABLE cloud_performance_backfill_cursors DROP CONSTRAINT IF EXISTS chk_cloud_performance_cursor_status;
ALTER TABLE cloud_performance_backfill_cursors ADD CONSTRAINT chk_cloud_performance_cursor_status CHECK(status IN ('active','completed'));
