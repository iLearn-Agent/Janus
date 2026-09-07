CREATE TABLE IF NOT EXISTS cloud_conversation_aliases_v7 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias_conversation_id text NOT NULL,
  canonical_conversation_id text NOT NULL,
  account_workspace_id text NOT NULL DEFAULT 'workspace_personal',
  agent_instance_id text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT 'agent_single_window_canonicalization',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, alias_conversation_id),
  CHECK(alias_conversation_id <> canonical_conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_conversation_aliases_v7_canonical
  ON cloud_conversation_aliases_v7(user_id, canonical_conversation_id);

DROP INDEX IF EXISTS idx_cloud_one_primary_agent_conversation;

CREATE UNIQUE INDEX idx_cloud_one_primary_agent_conversation
  ON cloud_conversations_v6(
    user_id,
    (COALESCE(payload_json->>'accountWorkspaceId',payload_json->>'account_workspace_id',
      payload_json->>'workspaceId',payload_json->>'workspace_id','workspace_personal')),
    (COALESCE(payload_json->>'agentInstanceId',payload_json->>'agent_instance_id',''))
  )
  WHERE conversation_role='primary'
    AND write_state='writable'
    AND COALESCE(payload_json->>'agentInstanceId',payload_json->>'agent_instance_id','')<>''
    AND COALESCE(payload_json->>'conversationKind',payload_json->>'conversation_kind','direct')='direct'
    AND COALESCE(payload_json->>'status','active')<>'deleted';
