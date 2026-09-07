CREATE TABLE IF NOT EXISTS cloud_sync_history_repairs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repair_kind text NOT NULL DEFAULT 'alias_cycle_history_snapshot_v1',
  repair_status text NOT NULL DEFAULT 'prepared'
    CHECK (repair_status IN ('prepared','completed')),
  snapshot_cursor bigint NOT NULL,
  deleted_change_count integer NOT NULL DEFAULT 0,
  replacement_entity_count integer NOT NULL DEFAULT 0,
  previous_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_compaction_state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_changes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  replacement_entities_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(user_id,repair_kind)
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_history_repairs_user
  ON cloud_sync_history_repairs(user_id,created_at DESC);

-- requires-real-postgres-tail: correlated history snapshots and DELETE ... USING are rehearsed on PostgreSQL and are unsupported by pg-mem.
WITH candidate_users AS (
  SELECT DISTINCT repair.user_id
  FROM cloud_agent_instance_alias_repairs repair
  WHERE repair.repair_kind='active_winner_two_node_cycle_v1'
), prepared AS (
  SELECT candidate.user_id,
    GREATEST(
      COALESCE((SELECT MAX(change_row.sequence_id)
        FROM cloud_sync_changes_v6 change_row
        WHERE change_row.user_id=candidate.user_id),0),
      COALESCE((SELECT snapshot.snapshot_cursor
        FROM cloud_sync_snapshots_v7 snapshot
        WHERE snapshot.user_id=candidate.user_id),0),
      COALESCE((SELECT state.last_snapshot_cursor
        FROM cloud_sync_compaction_states_v7 state
        WHERE state.user_id=candidate.user_id),0)
    ) AS snapshot_cursor,
    COALESCE((SELECT to_jsonb(snapshot)
      FROM cloud_sync_snapshots_v7 snapshot
      WHERE snapshot.user_id=candidate.user_id),'{}'::jsonb) AS previous_snapshot_json,
    COALESCE((SELECT to_jsonb(state)
      FROM cloud_sync_compaction_states_v7 state
      WHERE state.user_id=candidate.user_id),'{}'::jsonb) AS previous_compaction_state_json
  FROM candidate_users candidate
), repair_payload AS (
  SELECT prepared.*,
    COALESCE((SELECT COUNT(*)::integer
      FROM cloud_sync_changes_v6 change_row
      WHERE change_row.user_id=prepared.user_id
        AND change_row.sequence_id<=prepared.snapshot_cursor),0) AS deleted_change_count,
    COALESCE((SELECT jsonb_agg(to_jsonb(change_row) ORDER BY change_row.sequence_id)
      FROM cloud_sync_changes_v6 change_row
      WHERE change_row.user_id=prepared.user_id
        AND change_row.sequence_id<=prepared.snapshot_cursor),'[]'::jsonb) AS deleted_changes_json,
    COALESCE((SELECT COUNT(*)::integer
      FROM cloud_sync_entities_v6 entity_row
      WHERE entity_row.user_id=prepared.user_id),0) AS replacement_entity_count,
    COALESCE((SELECT jsonb_agg(
      jsonb_build_object(
        'changeId','snapshot_' || entity_row.entity_type || '_' || entity_row.entity_id || '_' || entity_row.revision,
        'sequenceId',prepared.snapshot_cursor::text,
        'entityType',entity_row.entity_type,
        'entityId',entity_row.entity_id,
        'operation',CASE WHEN entity_row.deleted THEN 'delete' ELSE 'upsert' END,
        'baseRevision',GREATEST(0,entity_row.revision-1),
        'revision',entity_row.revision,
        'contentHash',entity_row.content_hash,
        'occurredAt',entity_row.occurred_at,
        'acceptedAt',entity_row.updated_at,
        'minimumProtocolVersion',CASE WHEN entity_row.entity_type='conversation_alias' THEN 7 ELSE 6 END,
        'requiredCapabilities',CASE
          WHEN entity_row.entity_type='conversation_alias' THEN
            '["account-workspace-v2","agent-single-window-continuity-v1","conversation-identity-phase6","staged-sync-v6"]'::jsonb
          WHEN entity_row.entity_type IN ('conversation','message') THEN
            '["account-workspace-v2","conversation-identity-phase6","staged-sync-v6"]'::jsonb
          WHEN entity_row.entity_type IN ('project','model_execution','task_run') THEN
            '["account-workspace-v2","staged-sync-v6"]'::jsonb
          WHEN entity_row.entity_type='chat_context_state' THEN
            '["conversation-identity-phase6","staged-sync-v6"]'::jsonb
          WHEN entity_row.entity_type IN (
            'user_agent_instance','agent_instance_alias','agent_context_space','agent_context_state','memory_document'
          ) THEN '["canonical-agent-identity-v1","staged-sync-v6"]'::jsonb
          ELSE '["staged-sync-v6"]'::jsonb
        END,
        'payload',entity_row.payload_json
      ) ORDER BY entity_row.entity_type,entity_row.entity_id)
      FROM cloud_sync_entities_v6 entity_row
      WHERE entity_row.user_id=prepared.user_id),'[]'::jsonb) AS replacement_entities_json
  FROM prepared
)
INSERT INTO cloud_sync_history_repairs(
  id,user_id,snapshot_cursor,deleted_change_count,replacement_entity_count,
  previous_snapshot_json,previous_compaction_state_json,deleted_changes_json,replacement_entities_json
)
SELECT 'sync_history_repair_' || md5(user_id || E'\n' || 'alias_cycle_history_snapshot_v1'),
  user_id,snapshot_cursor,deleted_change_count,replacement_entity_count,
  previous_snapshot_json,previous_compaction_state_json,deleted_changes_json,replacement_entities_json
FROM repair_payload
WHERE snapshot_cursor>0
ON CONFLICT(user_id,repair_kind) DO NOTHING;

INSERT INTO cloud_sync_snapshots_v7(
  user_id,snapshot_cursor,entity_count,entities_json,created_at,updated_at
)
SELECT repair.user_id,repair.snapshot_cursor,repair.replacement_entity_count,
  repair.replacement_entities_json,now(),now()
FROM cloud_sync_history_repairs repair
WHERE repair.repair_kind='alias_cycle_history_snapshot_v1'
  AND repair.repair_status='prepared'
ON CONFLICT(user_id) DO UPDATE SET
  snapshot_cursor=excluded.snapshot_cursor,
  entity_count=excluded.entity_count,
  entities_json=excluded.entities_json,
  updated_at=now();

INSERT INTO cloud_sync_compaction_states_v7(
  user_id,compacted_through,last_snapshot_cursor,last_compacted_at,updated_at
)
SELECT repair.user_id,repair.snapshot_cursor,repair.snapshot_cursor,now(),now()
FROM cloud_sync_history_repairs repair
WHERE repair.repair_kind='alias_cycle_history_snapshot_v1'
  AND repair.repair_status='prepared'
ON CONFLICT(user_id) DO UPDATE SET
  compacted_through=GREATEST(cloud_sync_compaction_states_v7.compacted_through,excluded.compacted_through),
  last_snapshot_cursor=GREATEST(cloud_sync_compaction_states_v7.last_snapshot_cursor,excluded.last_snapshot_cursor),
  last_compacted_at=now(),
  updated_at=now();

DELETE FROM cloud_sync_changes_v6 change_row
USING cloud_sync_history_repairs repair
WHERE change_row.user_id=repair.user_id
  AND change_row.sequence_id<=repair.snapshot_cursor
  AND repair.repair_kind='alias_cycle_history_snapshot_v1'
  AND repair.repair_status='prepared';

UPDATE cloud_sync_history_repairs
SET repair_status='completed',completed_at=now()
WHERE repair_kind='alias_cycle_history_snapshot_v1'
  AND repair_status='prepared';
