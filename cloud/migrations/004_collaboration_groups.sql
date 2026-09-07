ALTER TABLE agent_delegations
  ADD COLUMN IF NOT EXISTS group_id text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_agent_delegations_group
  ON agent_delegations (group_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_groups (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'uBuddy 任务群',
  status text NOT NULL DEFAULT 'active',
  client_request_id text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE(owner_user_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS collaboration_group_members (
  group_id text NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'active',
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  last_read_at timestamptz,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_members_user
  ON collaboration_group_members (user_id, status, joined_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_group_messages (
  id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
  sender_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_agent_id text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'friend',
  content text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_collaboration_messages_group
  ON collaboration_group_messages (group_id, created_at ASC);

CREATE TABLE IF NOT EXISTS agent_delegation_revisions (
  id text PRIMARY KEY,
  delegation_id text NOT NULL REFERENCES agent_delegations(id) ON DELETE CASCADE,
  author_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision_no integer NOT NULL DEFAULT 1,
  action text NOT NULL DEFAULT 'draft',
  content text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(delegation_id, revision_no)
);

CREATE INDEX IF NOT EXISTS idx_agent_delegation_revisions
  ON agent_delegation_revisions (delegation_id, revision_no DESC);
