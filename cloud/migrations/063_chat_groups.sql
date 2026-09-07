CREATE TABLE IF NOT EXISTS chat_groups (
  id text PRIMARY KEY,
  account_workspace_id text NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,
  organization_id text NOT NULL DEFAULT '',
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title text NOT NULL DEFAULT '新群聊',
  scope_type text NOT NULL DEFAULT 'external',
  chat_mode text NOT NULL DEFAULT 'conversation',
  binding_type text NOT NULL DEFAULT 'manual',
  binding_id text NOT NULL DEFAULT '',
  history_visibility text NOT NULL DEFAULT 'from_join',
  status text NOT NULL DEFAULT 'active',
  client_request_id text NOT NULL,
  request_payload_hash text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  dissolved_at timestamptz,
  UNIQUE(account_workspace_id,owner_user_id,client_request_id),
  CHECK(scope_type IN ('internal','external')),
  CHECK(chat_mode IN ('conversation','topic')),
  CHECK(binding_type IN ('manual','organization','department')),
  CHECK(history_visibility IN ('from_join','full')),
  CHECK(status IN ('active','dissolved'))
);

CREATE TABLE IF NOT EXISTS chat_group_members (
  group_id text NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'active',
  invited_by_user_id text NOT NULL DEFAULT '',
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  last_read_at timestamptz,
  PRIMARY KEY(group_id,user_id),
  CHECK(role IN ('owner','admin','member')),
  CHECK(status IN ('invited','active','left','removed','declined'))
);

CREATE TABLE IF NOT EXISTS chat_group_messages (
  id text PRIMARY KEY,
  account_workspace_id text NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,
  group_id text NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  sender_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sender_agent_id text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'friend',
  content text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_event_id text NOT NULL DEFAULT '',
  request_payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(kind IN ('friend','agent','system'))
);

CREATE TABLE IF NOT EXISTS chat_group_operations (
  idempotency_key text PRIMARY KEY,
  group_id text NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation_kind text NOT NULL,
  request_payload_hash text NOT NULL,
  response_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(operation_kind IN ('update_group'))
);

CREATE INDEX IF NOT EXISTS idx_chat_groups_workspace
  ON chat_groups(account_workspace_id,status,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_group_members_user
  ON chat_group_members(user_id,status,joined_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_group_messages_group
  ON chat_group_messages(group_id,created_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_group_messages_source_event
  ON chat_group_messages(group_id,source_event_id) WHERE source_event_id<>'';
