CREATE TABLE IF NOT EXISTS cloud_chat_context_states (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  session_id text NOT NULL,
  context_space_id text NOT NULL DEFAULT '',
  context_epoch integer NOT NULL DEFAULT 1 CHECK(context_epoch >= 1),
  reset_after_message_id text NOT NULL DEFAULT '',
  reset_after_created_at timestamptz,
  last_execution_id text NOT NULL DEFAULT '',
  last_input_tokens bigint NOT NULL DEFAULT 0 CHECK(last_input_tokens >= 0),
  context_window_tokens bigint NOT NULL DEFAULT 0 CHECK(context_window_tokens >= 0),
  provider_compaction_detected boolean NOT NULL DEFAULT false,
  state_revision bigint NOT NULL DEFAULT 1 CHECK(state_revision >= 1),
  last_command_id text NOT NULL DEFAULT '',
  source_device_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,session_id,context_space_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_chat_context_states_updated
  ON cloud_chat_context_states(owner_user_id,updated_at,id);

CREATE INDEX IF NOT EXISTS idx_cloud_chat_context_states_session
  ON cloud_chat_context_states(owner_user_id,session_id,context_space_id);
