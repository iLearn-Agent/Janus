CREATE TABLE IF NOT EXISTS agent_delegation_workspaces (
  delegation_id text NOT NULL REFERENCES agent_delegations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (delegation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_delegation_workspaces_user
  ON agent_delegation_workspaces (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_delegation_workspace_messages (
  id text PRIMARY KEY,
  delegation_id text NOT NULL REFERENCES agent_delegations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'user',
  content text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_event_id text NOT NULL DEFAULT '',
  source_group_message_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delegation_id, user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agent_delegation_workspace_messages_owner
  ON agent_delegation_workspace_messages (delegation_id, user_id, created_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_delegation_workspace_messages_source_event
  ON agent_delegation_workspace_messages (delegation_id, user_id, source_event_id)
  WHERE source_event_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_delegation_workspace_messages_source_group
  ON agent_delegation_workspace_messages (delegation_id, user_id, source_group_message_id)
  WHERE source_group_message_id <> '';

INSERT INTO agent_delegation_workspaces (delegation_id, user_id, session_id, updated_at)
SELECT id, recipient_user_id, session_id, updated_at
FROM agent_delegations
WHERE session_id <> ''
ON CONFLICT (delegation_id, user_id) DO NOTHING;
