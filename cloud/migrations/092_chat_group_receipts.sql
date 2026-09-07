CREATE TABLE IF NOT EXISTS chat_group_message_receipts (
  message_id text NOT NULL REFERENCES chat_group_messages(id) ON DELETE CASCADE,
  group_id text NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  recipient_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, recipient_user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_group_receipts_reader
  ON chat_group_message_receipts (group_id, recipient_user_id, read_at, created_at);

ALTER TABLE social_conversation_preferences
  ADD COLUMN IF NOT EXISTS removed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_social_conversation_preferences_removed
  ON social_conversation_preferences (user_id, removed_at, updated_at DESC);
