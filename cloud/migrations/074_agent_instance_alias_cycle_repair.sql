CREATE TABLE IF NOT EXISTS cloud_agent_instance_alias_repairs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  removed_alias_instance_id text NOT NULL,
  removed_canonical_instance_id text NOT NULL,
  preserved_alias_instance_id text NOT NULL,
  preserved_canonical_instance_id text NOT NULL,
  repair_kind text NOT NULL DEFAULT 'active_winner_two_node_cycle_v1',
  alias_row_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  entity_row_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_rows_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_alias_repairs_user
  ON cloud_agent_instance_alias_repairs(user_id,created_at DESC);

-- requires-real-postgres-tail: correlated repair snapshots and DELETE ... USING are rehearsed on PostgreSQL and are unsupported by pg-mem.
WITH repairable AS (
  SELECT forward.user_id,
    forward.alias_instance_id removed_alias_instance_id,
    forward.canonical_instance_id removed_canonical_instance_id,
    reverse.alias_instance_id preserved_alias_instance_id,
    reverse.canonical_instance_id preserved_canonical_instance_id,
    to_jsonb(forward) alias_row_json,
    COALESCE((SELECT to_jsonb(entity_row) FROM cloud_sync_entities_v6 entity_row
      WHERE entity_row.user_id=forward.user_id
        AND entity_row.entity_type='agent_instance_alias'
        AND entity_row.entity_id=forward.alias_instance_id), '{}'::jsonb) entity_row_json,
    COALESCE((SELECT jsonb_agg(to_jsonb(change_row) ORDER BY change_row.sequence_id)
      FROM cloud_sync_changes_v6 change_row
      WHERE change_row.user_id=forward.user_id
        AND change_row.entity_type='agent_instance_alias'
        AND change_row.entity_id=forward.alias_instance_id), '[]'::jsonb) change_rows_json
  FROM cloud_user_agent_instance_aliases_v3 forward
  JOIN cloud_user_agent_instance_aliases_v3 reverse
    ON reverse.user_id=forward.user_id
   AND reverse.alias_instance_id=forward.canonical_instance_id
   AND reverse.canonical_instance_id=forward.alias_instance_id
  JOIN cloud_user_agent_instances_v3 alias_instance
    ON alias_instance.user_id=forward.user_id AND alias_instance.id=forward.alias_instance_id
  JOIN cloud_user_agent_instances_v3 canonical_instance
    ON canonical_instance.user_id=forward.user_id AND canonical_instance.id=forward.canonical_instance_id
  WHERE alias_instance.status='active' AND canonical_instance.status='inactive'
)
INSERT INTO cloud_agent_instance_alias_repairs(
  id,user_id,removed_alias_instance_id,removed_canonical_instance_id,
  preserved_alias_instance_id,preserved_canonical_instance_id,
  alias_row_json,entity_row_json,change_rows_json
)
SELECT 'alias_repair_' || md5(user_id || E'\n' || removed_alias_instance_id || E'\n' || removed_canonical_instance_id),
  user_id,removed_alias_instance_id,removed_canonical_instance_id,
  preserved_alias_instance_id,preserved_canonical_instance_id,
  alias_row_json,entity_row_json,change_rows_json
FROM repairable
ON CONFLICT(id) DO NOTHING;

DELETE FROM cloud_sync_changes_v6 change_row
USING cloud_agent_instance_alias_repairs repair
WHERE change_row.user_id=repair.user_id
  AND change_row.entity_type='agent_instance_alias'
  AND change_row.entity_id=repair.removed_alias_instance_id
  AND repair.repair_kind='active_winner_two_node_cycle_v1';

DELETE FROM cloud_sync_entities_v6 entity_row
USING cloud_agent_instance_alias_repairs repair
WHERE entity_row.user_id=repair.user_id
  AND entity_row.entity_type='agent_instance_alias'
  AND entity_row.entity_id=repair.removed_alias_instance_id
  AND repair.repair_kind='active_winner_two_node_cycle_v1';

DELETE FROM cloud_user_agent_instance_aliases_v3 alias_row
USING cloud_agent_instance_alias_repairs repair
WHERE alias_row.user_id=repair.user_id
  AND alias_row.alias_instance_id=repair.removed_alias_instance_id
  AND alias_row.canonical_instance_id=repair.removed_canonical_instance_id
  AND repair.repair_kind='active_winner_two_node_cycle_v1';
