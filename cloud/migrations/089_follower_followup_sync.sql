CREATE TABLE IF NOT EXISTS cloud_follower_followup_messages (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_workspace_id text NOT NULL DEFAULT 'workspace_personal',
  message_id text NOT NULL,
  thread_id text NOT NULL,
  report_id text NOT NULL,
  origin_device_id text NOT NULL DEFAULT '',
  role text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id,account_workspace_id,message_id),
  CHECK(role IN ('user','assistant'))
);
CREATE INDEX IF NOT EXISTS idx_cloud_follower_followup_report
  ON cloud_follower_followup_messages(owner_user_id,account_workspace_id,report_id,created_at,message_id);
