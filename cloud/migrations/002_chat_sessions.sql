CREATE TABLE IF NOT EXISTS chat_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Untitled',
  department_id text NOT NULL DEFAULT '',
  agent_id text NOT NULL DEFAULT '',
  codex_thread_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  pinned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_recent
  ON chat_sessions (user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_pinned
  ON chat_sessions (user_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL;
