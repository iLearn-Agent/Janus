CREATE TABLE IF NOT EXISTS account_workspaces (
  id text PRIMARY KEY,
  workspace_kind text NOT NULL,
  organization_id text NOT NULL DEFAULT '',
  owner_user_id text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  avatar_url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_workspaces_organization
  ON account_workspaces (organization_id) WHERE organization_id <> '';

CREATE TABLE IF NOT EXISTS account_workspace_memberships (
  workspace_id text NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'active',
  display_name text NOT NULL DEFAULT '',
  avatar_url text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,user_id)
);

CREATE INDEX IF NOT EXISTS idx_account_workspace_memberships_user
  ON account_workspace_memberships (user_id,status,updated_at DESC);

INSERT INTO account_workspaces(id,workspace_kind,name,status)
VALUES('workspace_personal','personal','个人空间','active')
ON CONFLICT(id) DO UPDATE SET status='active',updated_at=now();

INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,display_name,avatar_url,joined_at,updated_at)
SELECT 'workspace_personal',id,'owner','active',COALESCE(display_name,''),COALESCE(avatar_url,''),created_at,now()
FROM users
ON CONFLICT(workspace_id,user_id) DO UPDATE SET status='active',display_name=excluded.display_name,
  avatar_url=excluded.avatar_url,updated_at=excluded.updated_at;

INSERT INTO account_workspaces(id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at)
SELECT 'workspace_org_' || id,'organization',id,owner_user_id,name,'active',created_at,updated_at
FROM contact_organizations
ON CONFLICT(id) DO UPDATE SET organization_id=excluded.organization_id,owner_user_id=excluded.owner_user_id,
  name=excluded.name,status='active',updated_at=excluded.updated_at;

INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,joined_at,updated_at)
SELECT 'workspace_org_' || organization_id,user_id,
  CASE WHEN role IN ('owner','admin') THEN role ELSE 'member' END,'active',joined_at,updated_at
FROM contact_organization_members
ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active',updated_at=excluded.updated_at;

-- Migration 060 temporarily projected organization membership into the global
-- friendship graph. Account Workspaces make those synthetic edges invalid;
-- explicitly added friendships use different identifiers and are preserved.
DELETE FROM friendships WHERE id LIKE 'friendship_org_%';

ALTER TABLE IF EXISTS social_messages ADD COLUMN IF NOT EXISTS account_workspace_id text NOT NULL DEFAULT 'workspace_personal';
ALTER TABLE IF EXISTS agent_delegations ADD COLUMN IF NOT EXISTS account_workspace_id text NOT NULL DEFAULT 'workspace_personal';
ALTER TABLE IF EXISTS collaboration_groups ADD COLUMN IF NOT EXISTS account_workspace_id text NOT NULL DEFAULT 'workspace_personal';
ALTER TABLE IF EXISTS collaboration_group_messages ADD COLUMN IF NOT EXISTS account_workspace_id text NOT NULL DEFAULT 'workspace_personal';
ALTER TABLE IF EXISTS cloud_task_runs ADD COLUMN IF NOT EXISTS account_workspace_id text NOT NULL DEFAULT 'workspace_personal';
ALTER TABLE IF EXISTS social_message_files ADD COLUMN IF NOT EXISTS account_workspace_id text NOT NULL DEFAULT 'workspace_personal';
ALTER TABLE IF EXISTS chat_sessions ADD COLUMN IF NOT EXISTS account_workspace_id text NOT NULL DEFAULT 'workspace_personal';

CREATE INDEX IF NOT EXISTS idx_social_messages_workspace_recipient
  ON social_messages(account_workspace_id,recipient_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_delegations_workspace_user
  ON agent_delegations(account_workspace_id,requester_user_id,recipient_user_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_collaboration_groups_workspace
  ON collaboration_groups(account_workspace_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_collaboration_group_messages_workspace
  ON collaboration_group_messages(account_workspace_id,group_id,created_at);
CREATE INDEX IF NOT EXISTS idx_cloud_task_runs_workspace
  ON cloud_task_runs(account_workspace_id,owner_user_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_message_files_workspace
  ON social_message_files(account_workspace_id,owner_user_id,recipient_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_workspace_recent
  ON chat_sessions(account_workspace_id,user_id,status,updated_at DESC);

ALTER TABLE collaboration_groups DROP CONSTRAINT IF EXISTS collaboration_groups_owner_user_id_client_request_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_groups_workspace_request
  ON collaboration_groups(account_workspace_id,owner_user_id,client_request_id);

-- requires-real-postgres-tail: account Workspace synchronization triggers use PL/pgSQL.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='account_workspaces'::regclass AND conname='account_workspaces_kind_check'
  ) THEN
    ALTER TABLE account_workspaces
      ADD CONSTRAINT account_workspaces_kind_check CHECK (workspace_kind IN ('personal','organization'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='account_workspace_memberships'::regclass
      AND conname='account_workspace_memberships_role_check'
  ) THEN
    ALTER TABLE account_workspace_memberships
      ADD CONSTRAINT account_workspace_memberships_role_check CHECK (role IN ('owner','admin','member','guest'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='account_workspace_memberships'::regclass
      AND conname='account_workspace_memberships_status_check'
  ) THEN
    ALTER TABLE account_workspace_memberships
      ADD CONSTRAINT account_workspace_memberships_status_check CHECK (status IN ('active','left','removed','suspended'));
  END IF;
END;
$$;

UPDATE collaboration_group_messages AS message
SET account_workspace_id=COALESCE(collaboration_groups.account_workspace_id,'workspace_personal')
FROM collaboration_groups
WHERE collaboration_groups.id=message.group_id;

ALTER TABLE IF EXISTS task_runs ADD COLUMN IF NOT EXISTS account_workspace_id text NOT NULL DEFAULT 'workspace_personal';
ALTER TABLE IF EXISTS projects ADD COLUMN IF NOT EXISTS account_workspace_id text NOT NULL DEFAULT 'workspace_personal';
ALTER TABLE IF EXISTS conversations ADD COLUMN IF NOT EXISTS account_workspace_id text NOT NULL DEFAULT 'workspace_personal';
ALTER TABLE IF EXISTS messages ADD COLUMN IF NOT EXISTS account_workspace_id text NOT NULL DEFAULT 'workspace_personal';
ALTER TABLE IF EXISTS memory_documents ADD COLUMN IF NOT EXISTS account_workspace_id text NOT NULL DEFAULT 'workspace_personal';
ALTER TABLE IF EXISTS agent_context_spaces ADD COLUMN IF NOT EXISTS account_workspace_id text NOT NULL DEFAULT 'workspace_personal';
ALTER TABLE IF EXISTS agent_context_state ADD COLUMN IF NOT EXISTS account_workspace_id text NOT NULL DEFAULT 'workspace_personal';

CREATE OR REPLACE FUNCTION sync_account_workspace_organization() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE account_workspaces SET status='inactive',updated_at=now()
      WHERE id='workspace_org_' || OLD.id;
    UPDATE account_workspace_memberships SET status='removed',updated_at=now()
      WHERE workspace_id='workspace_org_' || OLD.id;
    RETURN OLD;
  END IF;
  INSERT INTO account_workspaces(id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at)
  VALUES('workspace_org_' || NEW.id,'organization',NEW.id,NEW.owner_user_id,NEW.name,'active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_account_workspace_organization ON contact_organizations;
CREATE TRIGGER trg_sync_account_workspace_organization
AFTER INSERT OR UPDATE OR DELETE ON contact_organizations
FOR EACH ROW EXECUTE FUNCTION sync_account_workspace_organization();

CREATE OR REPLACE FUNCTION sync_account_workspace_membership() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE account_workspace_memberships SET status=CASE
        WHEN EXISTS(SELECT 1 FROM account_workspaces WHERE id='workspace_org_' || OLD.organization_id AND status='inactive')
          THEN 'removed'
        ELSE 'left'
      END,updated_at=now()
      WHERE workspace_id='workspace_org_' || OLD.organization_id AND user_id=OLD.user_id;
    RETURN OLD;
  END IF;
  INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,joined_at,updated_at)
  VALUES('workspace_org_' || NEW.organization_id,NEW.user_id,
    CASE WHEN NEW.role IN ('owner','admin') THEN NEW.role ELSE 'member' END,'active',NEW.joined_at,NEW.updated_at)
  ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active',updated_at=excluded.updated_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_account_workspace_membership ON contact_organization_members;
CREATE TRIGGER trg_sync_account_workspace_membership
AFTER INSERT OR UPDATE OR DELETE ON contact_organization_members
FOR EACH ROW EXECUTE FUNCTION sync_account_workspace_membership();

CREATE OR REPLACE FUNCTION sync_personal_account_workspace_membership() RETURNS trigger AS $$
BEGIN
  INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,display_name,avatar_url,joined_at,updated_at)
  VALUES('workspace_personal',NEW.id,'owner','active',COALESCE(NEW.display_name,''),COALESCE(NEW.avatar_url,''),NEW.created_at,NEW.updated_at)
  ON CONFLICT(workspace_id,user_id) DO UPDATE SET status='active',display_name=excluded.display_name,
    avatar_url=excluded.avatar_url,updated_at=excluded.updated_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_personal_account_workspace_membership ON users;
CREATE TRIGGER trg_sync_personal_account_workspace_membership
AFTER INSERT OR UPDATE OF display_name,avatar_url,updated_at ON users
FOR EACH ROW EXECUTE FUNCTION sync_personal_account_workspace_membership();
