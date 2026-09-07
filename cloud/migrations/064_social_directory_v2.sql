ALTER TABLE chat_groups
  ADD COLUMN IF NOT EXISTS audience_scope text NOT NULL DEFAULT 'account_social';

ALTER TABLE chat_groups
  DROP CONSTRAINT IF EXISTS chk_chat_groups_audience_scope;

ALTER TABLE chat_groups
  ADD CONSTRAINT chk_chat_groups_audience_scope
  CHECK(audience_scope IN ('account_social','workspace_legacy'));

CREATE INDEX IF NOT EXISTS idx_chat_groups_audience_member
  ON chat_groups(audience_scope,status,updated_at DESC);
