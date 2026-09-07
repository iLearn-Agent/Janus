CREATE TABLE IF NOT EXISTS social_messages (
  id text PRIMARY KEY,
  sender_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_agent_id text NOT NULL DEFAULT '',
  recipient_agent_id text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'friend',
  title text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'unread',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_social_messages_recipient_created
  ON social_messages (recipient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_messages_pair_created
  ON social_messages (sender_user_id, recipient_user_id, created_at);

CREATE TABLE IF NOT EXISTS agent_delegations (
  id text PRIMARY KEY,
  requester_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_agent_id text NOT NULL DEFAULT 'secretary_agent',
  recipient_agent_id text NOT NULL DEFAULT 'secretary_agent',
  title text NOT NULL DEFAULT '',
  instruction text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'assigned',
  session_id text NOT NULL DEFAULT '',
  task_run_id text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_agent_delegations_recipient_status
  ON agent_delegations (recipient_user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_delegations_requester_status
  ON agent_delegations (requester_user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS user_presence (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  platform text NOT NULL DEFAULT '',
  arch text NOT NULL DEFAULT '',
  hostname text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'online',
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_user_presence_seen ON user_presence (user_id, last_seen_at DESC);
