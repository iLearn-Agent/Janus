ALTER TABLE collaboration_group_messages
  ADD COLUMN IF NOT EXISTS source_event_id text NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_group_messages_source_event
  ON collaboration_group_messages(group_id, source_event_id)
  WHERE source_event_id <> '';

CREATE TABLE IF NOT EXISTS task_node_result_versions (
  id text PRIMARY KEY,
  task_run_id text NOT NULL,
  task_node_id text NOT NULL,
  graph_revision_id text NOT NULL DEFAULT '',
  version_no integer NOT NULL DEFAULT 1,
  result_text text NOT NULL DEFAULT '',
  result_summary text NOT NULL DEFAULT '',
  evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision text NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','adopted','superseded','rejected')),
  decision_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE(task_node_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_task_node_result_versions_run
  ON task_node_result_versions(task_run_id, graph_revision_id, created_at);
