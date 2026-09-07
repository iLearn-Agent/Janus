ALTER TABLE agent_delegation_workspace_messages
  ADD COLUMN IF NOT EXISTS source_event_id text NOT NULL DEFAULT '';

ALTER TABLE agent_delegation_workspace_messages
  ADD COLUMN IF NOT EXISTS source_group_message_id text NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_delegation_workspace_messages_source_event
  ON agent_delegation_workspace_messages (delegation_id, user_id, source_event_id)
  WHERE source_event_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_delegation_workspace_messages_source_group
  ON agent_delegation_workspace_messages (delegation_id, user_id, source_group_message_id)
  WHERE source_group_message_id <> '';
