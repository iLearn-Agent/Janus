CREATE TABLE IF NOT EXISTS accounts (
  id text PRIMARY KEY,
  account_kind text NOT NULL CHECK (account_kind IN ('personal','organization')),
  owner_user_id text NOT NULL DEFAULT '',
  organization_id text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted','external')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((account_kind='personal' AND owner_user_id<>'' AND organization_id='')
    OR (account_kind='organization' AND organization_id<>''))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_personal_owner
  ON accounts(owner_user_id) WHERE account_kind='personal';
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_organization
  ON accounts(organization_id) WHERE account_kind='organization';

CREATE TABLE IF NOT EXISTS account_memberships_v8 (
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member','guest')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','left','removed','suspended')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,user_id)
);

CREATE INDEX IF NOT EXISTS idx_account_memberships_v8_user
  ON account_memberships_v8(user_id,status,updated_at DESC);

CREATE TABLE IF NOT EXISTS account_workspace_bindings_v8 (
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES account_workspaces(id) ON DELETE CASCADE,
  user_id_scope text NOT NULL DEFAULT '',
  binding_kind text NOT NULL CHECK (binding_kind IN ('personal','organization')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,workspace_id,user_id_scope),
  UNIQUE(workspace_id,user_id_scope)
);

INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
SELECT 'account_personal_' || id,'personal',id,'',COALESCE(display_name,'个人账号'),'active',created_at,updated_at
FROM users
ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;

INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
SELECT 'account_personal_' || id,id,'owner','active',created_at,updated_at FROM users
ON CONFLICT(account_id,user_id) DO UPDATE SET role='owner',status='active',updated_at=excluded.updated_at;

INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
SELECT 'account_personal_' || id,'workspace_personal',id,'personal',created_at,updated_at FROM users
ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,binding_kind='personal',updated_at=excluded.updated_at;

INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
SELECT 'account_org_' || organization_id,'organization',owner_user_id,organization_id,name,
  CASE WHEN status='active' THEN 'active' ELSE 'archived' END,created_at,updated_at
FROM account_workspaces WHERE workspace_kind='organization' AND organization_id<>''
ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,organization_id=excluded.organization_id,
  name=excluded.name,status=excluded.status,updated_at=excluded.updated_at;

INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
SELECT 'account_org_' || organization_id,id,'','organization',created_at,updated_at
FROM account_workspaces WHERE workspace_kind='organization' AND organization_id<>''
ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,binding_kind='organization',updated_at=excluded.updated_at;

INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
SELECT 'account_org_' || workspace.organization_id,membership.user_id,membership.role,membership.status,
  membership.joined_at,membership.updated_at
FROM account_workspace_memberships membership
JOIN account_workspaces workspace ON workspace.id=membership.workspace_id
WHERE workspace.workspace_kind='organization' AND workspace.organization_id<>''
ON CONFLICT(account_id,user_id) DO UPDATE SET role=excluded.role,status=excluded.status,updated_at=excluded.updated_at;

CREATE TABLE IF NOT EXISTS cloud_sync_batches_v8 (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  client_cursor text NOT NULL DEFAULT '',
  accepted_cursor text NOT NULL DEFAULT '',
  item_count integer NOT NULL DEFAULT 0,
  conflict_count integer NOT NULL DEFAULT 0,
  payload_hash text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'accepted',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,user_id,device_id,payload_hash)
);

CREATE TABLE IF NOT EXISTS cloud_sync_entities_v8 (
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  deleted boolean NOT NULL DEFAULT false,
  content_hash text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  origin_user_id text NOT NULL DEFAULT '',
  origin_device_id text NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,entity_type,entity_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_entities_v8_changed
  ON cloud_sync_entities_v8(account_id,updated_at,entity_type,entity_id);

CREATE TABLE IF NOT EXISTS cloud_sync_changes_v8 (
  sequence_id bigserial PRIMARY KEY,
  change_id text NOT NULL UNIQUE,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  batch_id text NOT NULL REFERENCES cloud_sync_batches_v8(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('upsert','delete')),
  base_revision bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL,
  content_hash text NOT NULL DEFAULT '',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_changes_v8_cursor
  ON cloud_sync_changes_v8(account_id,sequence_id);

CREATE TABLE IF NOT EXISTS cloud_sync_conflicts_v8 (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  batch_id text NOT NULL REFERENCES cloud_sync_batches_v8(id) ON DELETE CASCADE,
  change_id text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  conflict_kind text NOT NULL,
  server_revision bigint NOT NULL DEFAULT 0,
  client_base_revision bigint NOT NULL DEFAULT 0,
  server_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'preserved',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_sync_snapshots_v8 (
  account_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  snapshot_cursor bigint NOT NULL DEFAULT 0,
  entity_count integer NOT NULL DEFAULT 0,
  entities_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_sync_compaction_states_v8 (
  account_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  compacted_through bigint NOT NULL DEFAULT 0,
  last_snapshot_cursor bigint NOT NULL DEFAULT 0,
  last_compacted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_sync_device_cursors_v8 (
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  last_cursor bigint NOT NULL DEFAULT 0,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  reset_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY(account_id,user_id,device_id)
);

CREATE TABLE IF NOT EXISTS cloud_sync_usage_v8 (
  account_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_change_cursor bigint NOT NULL DEFAULT 0,
  change_count bigint NOT NULL DEFAULT 0,
  conflict_count bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- requires-real-postgres-tail: account principal synchronization triggers use PL/pgSQL.
CREATE OR REPLACE FUNCTION sync_personal_account_v8() RETURNS trigger AS $$
BEGIN
  INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
  VALUES('account_personal_' || NEW.id,'personal',NEW.id,'',COALESCE(NEW.display_name,'个人账号'),'active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,status='active',updated_at=excluded.updated_at;
  INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
  VALUES('account_personal_' || NEW.id,NEW.id,'owner','active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(account_id,user_id) DO UPDATE SET status='active',updated_at=excluded.updated_at;
  INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
  VALUES('account_personal_' || NEW.id,'workspace_personal',NEW.id,'personal',NEW.created_at,NEW.updated_at)
  ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,updated_at=excluded.updated_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_personal_account_v8 ON users;
CREATE TRIGGER trg_sync_personal_account_v8
AFTER INSERT OR UPDATE OF display_name,updated_at ON users
FOR EACH ROW EXECUTE FUNCTION sync_personal_account_v8();

CREATE OR REPLACE FUNCTION sync_organization_account_v8() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE accounts SET status='archived',updated_at=now() WHERE id='account_org_' || OLD.id;
    UPDATE account_memberships_v8 SET status='removed',updated_at=now() WHERE account_id='account_org_' || OLD.id;
    RETURN OLD;
  END IF;
  INSERT INTO account_workspaces(id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at)
  VALUES('workspace_org_' || NEW.id,'organization',NEW.id,NEW.owner_user_id,NEW.name,'active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
  INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
  VALUES('account_org_' || NEW.id,'organization',NEW.owner_user_id,NEW.id,NEW.name,'active',NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at;
  INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
  VALUES('account_org_' || NEW.id,'workspace_org_' || NEW.id,'','organization',NEW.created_at,NEW.updated_at)
  ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,binding_kind='organization',updated_at=excluded.updated_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_organization_account_v8 ON contact_organizations;
CREATE TRIGGER trg_sync_organization_account_v8
AFTER INSERT OR UPDATE OR DELETE ON contact_organizations
FOR EACH ROW EXECUTE FUNCTION sync_organization_account_v8();

CREATE OR REPLACE FUNCTION sync_organization_account_membership_v8() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE account_memberships_v8 SET status=CASE
        WHEN EXISTS(SELECT 1 FROM accounts WHERE id='account_org_' || OLD.organization_id AND status='archived') THEN 'removed'
        ELSE 'left'
      END,updated_at=now()
    WHERE account_id='account_org_' || OLD.organization_id AND user_id=OLD.user_id;
    RETURN OLD;
  END IF;
  INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
  VALUES('account_org_' || NEW.organization_id,NEW.user_id,
    CASE WHEN NEW.role IN ('owner','admin') THEN NEW.role ELSE 'member' END,'active',NEW.joined_at,NEW.updated_at)
  ON CONFLICT(account_id,user_id) DO UPDATE SET role=excluded.role,status='active',updated_at=excluded.updated_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_organization_account_membership_v8 ON contact_organization_members;
CREATE TRIGGER trg_sync_organization_account_membership_v8
AFTER INSERT OR UPDATE OR DELETE ON contact_organization_members
FOR EACH ROW EXECUTE FUNCTION sync_organization_account_membership_v8();
