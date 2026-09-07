CREATE TABLE IF NOT EXISTS social_conversation_preferences (
  account_workspace_id text NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_kind text NOT NULL,
  conversation_id text NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  state_revision bigint NOT NULL DEFAULT 1,
  last_command_id text NOT NULL DEFAULT '',
  source_device_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_workspace_id, user_id, conversation_kind, conversation_id),
  CHECK (conversation_kind IN ('chat_group', 'collaboration_group')),
  CHECK (state_revision >= 1)
);

CREATE TABLE IF NOT EXISTS social_conversation_preference_commands (
  command_id text PRIMARY KEY,
  account_workspace_id text NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_kind text NOT NULL,
  conversation_id text NOT NULL,
  request_payload_hash text NOT NULL,
  response_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (conversation_kind IN ('chat_group', 'collaboration_group'))
);

CREATE INDEX IF NOT EXISTS idx_social_conversation_preferences_user
  ON social_conversation_preferences (user_id, archived, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_social_conversation_preference_commands_user
  ON social_conversation_preference_commands (user_id, created_at DESC);
