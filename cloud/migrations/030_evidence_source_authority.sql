CREATE TABLE IF NOT EXISTS cloud_task_events (
  id text PRIMARY KEY,
  task_run_id text NOT NULL DEFAULT '',
  task_node_id text NOT NULL DEFAULT '',
  event_type text NOT NULL DEFAULT '',
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_task_events_source
  ON cloud_task_events(owner_user_id, task_run_id, task_node_id, created_at);
