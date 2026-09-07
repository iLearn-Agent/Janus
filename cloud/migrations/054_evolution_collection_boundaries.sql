CREATE TABLE IF NOT EXISTS cloud_evolution_collection_boundaries (
  source_kind text PRIMARY KEY,
  collect_after timestamptz NOT NULL,
  reason text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- requires-real-postgres-tail: production roles are not available under pg-mem.
GRANT SELECT,INSERT,UPDATE ON cloud_evolution_collection_boundaries TO janus_evolution_worker,janus_migrator;
