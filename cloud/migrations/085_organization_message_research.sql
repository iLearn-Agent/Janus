CREATE TABLE IF NOT EXISTS organization_research_policies (
  organization_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','revoked')),
  enabled_at timestamptz NOT NULL,
  enabled_by_user_id text NOT NULL,
  policy_version text NOT NULL DEFAULT 'organization-message-research-v1',
  confirmation_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_research_documents (
  organization_id text NOT NULL,
  account_workspace_id text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('workspace_message','direct_message','chat_group','collaboration_group')),
  source_message_id text NOT NULL,
  conversation_id text NOT NULL,
  conversation_title text NOT NULL DEFAULT '',
  sender_user_id text NOT NULL DEFAULT '',
  sender_display_name text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  attachment_names_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_created_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  tombstone boolean NOT NULL DEFAULT false,
  tombstone_reason text NOT NULL DEFAULT '',
  projected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,source_kind,source_message_id)
);

CREATE INDEX IF NOT EXISTS idx_organization_research_documents_conversation
  ON organization_research_documents(organization_id,conversation_id,source_created_at,source_message_id);
CREATE INDEX IF NOT EXISTS idx_organization_research_documents_sender
  ON organization_research_documents(organization_id,sender_user_id,source_created_at DESC);

CREATE TABLE IF NOT EXISTS organization_research_changes (
  sequence_id bigserial PRIMARY KEY,
  organization_id text NOT NULL,
  source_kind text NOT NULL,
  source_message_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('upsert','tombstone')),
  revision bigint NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_organization_research_changes_cursor
  ON organization_research_changes(organization_id,sequence_id);

CREATE TABLE IF NOT EXISTS organization_research_device_leases (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  user_id text NOT NULL,
  device_id text NOT NULL,
  lease_token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_renewed_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(organization_id,user_id,device_id)
);

CREATE INDEX IF NOT EXISTS idx_organization_research_leases_expiry
  ON organization_research_device_leases(organization_id,user_id,status,expires_at);

CREATE TABLE IF NOT EXISTS organization_research_audits (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL,
  organization_id text NOT NULL,
  querying_user_id text NOT NULL,
  device_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('online','offline','fallback')),
  query_hash text NOT NULL,
  filters_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  citation_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  client_created_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,querying_user_id,idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_organization_research_audits_viewer
  ON organization_research_audits(organization_id,querying_user_id,created_at DESC);

-- requires-real-postgres-tail: transactional organization-message projection uses PL/pgSQL triggers.

CREATE OR REPLACE FUNCTION organization_research_attachment_names(metadata jsonb) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(name ORDER BY ordinal), '[]'::jsonb)
  FROM (
    SELECT ordinal, COALESCE(item->>'name', item->>'filename', '') AS name
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(metadata->'attachments')='array'
      THEN metadata->'attachments' ELSE '[]'::jsonb END) WITH ORDINALITY AS valueset(item,ordinal)
    WHERE COALESCE(item->>'name', item->>'filename', '') <> ''
  ) names;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION organization_research_sender_name(organization_key text, sender_id text) RETURNS text AS $$
  SELECT COALESCE(NULLIF(member.display_name_override,''),NULLIF(sender.display_name,''),
    NULLIF(sender.username,''),sender.email,'')
  FROM users sender
  LEFT JOIN contact_organization_members member
    ON member.organization_id=organization_key AND member.user_id=sender.id
  WHERE sender.id=sender_id
  LIMIT 1;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION record_organization_research_change() RETURNS trigger AS $$
BEGIN
  INSERT INTO organization_research_changes(
    organization_id,source_kind,source_message_id,operation,revision,occurred_at
  ) VALUES(
    NEW.organization_id,NEW.source_kind,NEW.source_message_id,
    CASE WHEN NEW.tombstone THEN 'tombstone' ELSE 'upsert' END,NEW.revision,now()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_organization_research_document_change ON organization_research_documents;
CREATE TRIGGER trg_organization_research_document_change
AFTER INSERT OR UPDATE ON organization_research_documents
FOR EACH ROW EXECUTE FUNCTION record_organization_research_change();

CREATE OR REPLACE FUNCTION project_organization_direct_message() RETURNS trigger AS $$
DECLARE
  row_value social_messages%ROWTYPE;
  workspace account_workspaces%ROWTYPE;
  policy organization_research_policies%ROWTYPE;
  existing_revision bigint;
  removed boolean;
BEGIN
  row_value := CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  SELECT * INTO workspace FROM account_workspaces
    WHERE id=row_value.account_workspace_id AND workspace_kind='organization' AND status='active';
  IF NOT FOUND THEN RETURN row_value; END IF;
  SELECT * INTO policy FROM organization_research_policies
    WHERE organization_id=workspace.organization_id AND status='enabled';
  IF NOT FOUND THEN RETURN row_value; END IF;
  IF TG_OP='INSERT' AND row_value.created_at < policy.enabled_at THEN RETURN row_value; END IF;
  IF TG_OP<>'INSERT' AND NOT EXISTS(
    SELECT 1 FROM organization_research_documents WHERE organization_id=workspace.organization_id
      AND source_kind='direct_message' AND source_message_id=row_value.id
  ) THEN RETURN row_value; END IF;
  IF TG_OP='INSERT' AND (NOT EXISTS(SELECT 1 FROM account_workspace_memberships WHERE workspace_id=workspace.id
      AND user_id=row_value.sender_user_id AND status='active')
    OR NOT EXISTS(SELECT 1 FROM account_workspace_memberships WHERE workspace_id=workspace.id
      AND user_id=row_value.recipient_user_id AND status='active')) THEN RETURN row_value; END IF;
  removed := TG_OP='DELETE' OR COALESCE(row_value.metadata_json->>'withdrawn','false')='true';
  SELECT revision INTO existing_revision FROM organization_research_documents
    WHERE organization_id=workspace.organization_id AND source_kind='direct_message' AND source_message_id=row_value.id;
  INSERT INTO organization_research_documents(
    organization_id,account_workspace_id,source_kind,source_message_id,conversation_id,conversation_title,
    sender_user_id,sender_display_name,body,attachment_names_json,source_created_at,source_updated_at,revision,tombstone,tombstone_reason
  ) VALUES(
    workspace.organization_id,workspace.id,'direct_message',row_value.id,
    LEAST(row_value.sender_user_id,row_value.recipient_user_id) || ':' || GREATEST(row_value.sender_user_id,row_value.recipient_user_id),
    row_value.title,row_value.sender_user_id,
    COALESCE(organization_research_sender_name(workspace.organization_id,row_value.sender_user_id),''),
    CASE WHEN removed THEN '' ELSE row_value.content END,
    CASE WHEN removed THEN '[]'::jsonb ELSE organization_research_attachment_names(row_value.metadata_json) END,
    row_value.created_at,row_value.updated_at,COALESCE(existing_revision,0)+1,removed,
    CASE WHEN TG_OP='DELETE' THEN 'source_deleted' WHEN removed THEN 'source_withdrawn' ELSE '' END
  ) ON CONFLICT(organization_id,source_kind,source_message_id) DO UPDATE SET
    sender_display_name=excluded.sender_display_name,body=excluded.body,
    attachment_names_json=excluded.attachment_names_json,source_updated_at=excluded.source_updated_at,
    revision=excluded.revision,tombstone=excluded.tombstone,tombstone_reason=excluded.tombstone_reason,projected_at=now();
  RETURN row_value;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_project_organization_direct_message ON social_messages;
CREATE TRIGGER trg_project_organization_direct_message
AFTER INSERT OR UPDATE OR DELETE ON social_messages
FOR EACH ROW EXECUTE FUNCTION project_organization_direct_message();

CREATE OR REPLACE FUNCTION project_organization_chat_group_message() RETURNS trigger AS $$
DECLARE
  row_value chat_group_messages%ROWTYPE;
  group_value chat_groups%ROWTYPE;
  policy organization_research_policies%ROWTYPE;
  existing_revision bigint;
  removed boolean;
BEGIN
  row_value := CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  SELECT * INTO group_value FROM chat_groups WHERE id=row_value.group_id
    AND organization_id<>'' AND scope_type='internal';
  IF NOT FOUND THEN RETURN row_value; END IF;
  SELECT * INTO policy FROM organization_research_policies
    WHERE organization_id=group_value.organization_id AND status='enabled';
  IF NOT FOUND THEN RETURN row_value; END IF;
  IF TG_OP='INSERT' AND row_value.created_at < policy.enabled_at THEN RETURN row_value; END IF;
  IF TG_OP<>'INSERT' AND NOT EXISTS(SELECT 1 FROM organization_research_documents
    WHERE organization_id=group_value.organization_id AND source_kind='chat_group' AND source_message_id=row_value.id) THEN RETURN row_value; END IF;
  SELECT revision INTO existing_revision FROM organization_research_documents
    WHERE organization_id=group_value.organization_id AND source_kind='chat_group' AND source_message_id=row_value.id;
  removed := TG_OP='DELETE' OR COALESCE(row_value.metadata_json->>'withdrawn','false')='true';
  INSERT INTO organization_research_documents(
    organization_id,account_workspace_id,source_kind,source_message_id,conversation_id,conversation_title,
    sender_user_id,sender_display_name,body,attachment_names_json,source_created_at,source_updated_at,revision,tombstone,tombstone_reason
  ) VALUES(group_value.organization_id,row_value.account_workspace_id,'chat_group',row_value.id,row_value.group_id,
    group_value.title,row_value.sender_user_id,
    COALESCE(organization_research_sender_name(group_value.organization_id,row_value.sender_user_id),''),
    CASE WHEN removed THEN '' ELSE row_value.content END,
    CASE WHEN removed THEN '[]'::jsonb ELSE organization_research_attachment_names(row_value.metadata_json) END,
    row_value.created_at,row_value.updated_at,COALESCE(existing_revision,0)+1,removed,
    CASE WHEN TG_OP='DELETE' THEN 'source_deleted' WHEN removed THEN 'source_withdrawn' ELSE '' END)
  ON CONFLICT(organization_id,source_kind,source_message_id) DO UPDATE SET
    sender_display_name=excluded.sender_display_name,body=excluded.body,
    attachment_names_json=excluded.attachment_names_json,source_updated_at=excluded.source_updated_at,
    revision=excluded.revision,tombstone=excluded.tombstone,tombstone_reason=excluded.tombstone_reason,projected_at=now();
  RETURN row_value;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_project_organization_chat_group_message ON chat_group_messages;
CREATE TRIGGER trg_project_organization_chat_group_message
AFTER INSERT OR UPDATE OR DELETE ON chat_group_messages
FOR EACH ROW EXECUTE FUNCTION project_organization_chat_group_message();

CREATE OR REPLACE FUNCTION project_organization_collaboration_message() RETURNS trigger AS $$
DECLARE
  row_value collaboration_group_messages%ROWTYPE;
  group_value collaboration_groups%ROWTYPE;
  workspace account_workspaces%ROWTYPE;
  policy organization_research_policies%ROWTYPE;
  existing_revision bigint;
BEGIN
  row_value := CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  SELECT * INTO group_value FROM collaboration_groups WHERE id=row_value.group_id;
  IF NOT FOUND THEN RETURN row_value; END IF;
  SELECT * INTO workspace FROM account_workspaces WHERE id=group_value.account_workspace_id
    AND workspace_kind='organization' AND status='active';
  IF NOT FOUND THEN RETURN row_value; END IF;
  SELECT * INTO policy FROM organization_research_policies WHERE organization_id=workspace.organization_id AND status='enabled';
  IF NOT FOUND THEN RETURN row_value; END IF;
  IF TG_OP='INSERT' AND EXISTS(
    SELECT 1 FROM collaboration_group_members member
    LEFT JOIN account_workspace_memberships workspace_member
      ON workspace_member.workspace_id=workspace.id AND workspace_member.user_id=member.user_id AND workspace_member.status='active'
    WHERE member.group_id=group_value.id AND member.status='active' AND workspace_member.user_id IS NULL
  ) THEN RETURN row_value; END IF;
  IF TG_OP='INSERT' AND row_value.created_at < policy.enabled_at THEN RETURN row_value; END IF;
  IF TG_OP<>'INSERT' AND NOT EXISTS(SELECT 1 FROM organization_research_documents
    WHERE organization_id=workspace.organization_id AND source_kind='collaboration_group' AND source_message_id=row_value.id) THEN RETURN row_value; END IF;
  SELECT revision INTO existing_revision FROM organization_research_documents
    WHERE organization_id=workspace.organization_id AND source_kind='collaboration_group' AND source_message_id=row_value.id;
  INSERT INTO organization_research_documents(
    organization_id,account_workspace_id,source_kind,source_message_id,conversation_id,conversation_title,
    sender_user_id,sender_display_name,body,attachment_names_json,source_created_at,source_updated_at,revision,tombstone,tombstone_reason
  ) VALUES(workspace.organization_id,workspace.id,'collaboration_group',row_value.id,row_value.group_id,group_value.title,
    row_value.sender_user_id,
    COALESCE(organization_research_sender_name(workspace.organization_id,row_value.sender_user_id),''),
    CASE WHEN TG_OP='DELETE' THEN '' ELSE row_value.content END,
    CASE WHEN TG_OP='DELETE' THEN '[]'::jsonb ELSE organization_research_attachment_names(row_value.metadata_json) END,
    row_value.created_at,row_value.updated_at,COALESCE(existing_revision,0)+1,TG_OP='DELETE',CASE WHEN TG_OP='DELETE' THEN 'source_deleted' ELSE '' END)
  ON CONFLICT(organization_id,source_kind,source_message_id) DO UPDATE SET
    sender_display_name=excluded.sender_display_name,body=excluded.body,
    attachment_names_json=excluded.attachment_names_json,source_updated_at=excluded.source_updated_at,
    revision=excluded.revision,tombstone=excluded.tombstone,tombstone_reason=excluded.tombstone_reason,projected_at=now();
  RETURN row_value;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_project_organization_collaboration_message ON collaboration_group_messages;
CREATE TRIGGER trg_project_organization_collaboration_message
AFTER INSERT OR UPDATE OR DELETE ON collaboration_group_messages
FOR EACH ROW EXECUTE FUNCTION project_organization_collaboration_message();

CREATE OR REPLACE FUNCTION project_organization_workspace_message() RETURNS trigger AS $$
DECLARE
  row_value cloud_messages_v6%ROWTYPE;
  workspace account_workspaces%ROWTYPE;
  policy organization_research_policies%ROWTYPE;
  workspace_id text;
  created_time timestamptz;
  existing_revision bigint;
BEGIN
  row_value := CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  workspace_id := COALESCE(NULLIF(row_value.payload_json->>'accountWorkspaceId',''),row_value.payload_json->>'account_workspace_id');
  SELECT * INTO workspace FROM account_workspaces WHERE id=workspace_id AND workspace_kind='organization' AND status='active';
  IF NOT FOUND THEN RETURN row_value; END IF;
  IF COALESCE(row_value.payload_json->>'departmentId',row_value.payload_json->>'department_id','')='private_assistant'
    OR lower(COALESCE(row_value.payload_json->>'isolatedPrivateSession','false')) IN ('true','1') THEN RETURN row_value; END IF;
  SELECT * INTO policy FROM organization_research_policies WHERE organization_id=workspace.organization_id AND status='enabled';
  IF NOT FOUND THEN RETURN row_value; END IF;
  IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM account_workspace_memberships membership
    WHERE membership.workspace_id=workspace.id AND membership.user_id=row_value.user_id AND membership.status='active') THEN RETURN row_value; END IF;
  BEGIN
    created_time := COALESCE(NULLIF(row_value.payload_json->>'createdAt','')::timestamptz,
      NULLIF(row_value.payload_json->>'created_at','')::timestamptz,row_value.updated_at);
  EXCEPTION WHEN OTHERS THEN created_time := row_value.updated_at;
  END;
  IF TG_OP='INSERT' AND created_time < policy.enabled_at THEN RETURN row_value; END IF;
  IF TG_OP<>'INSERT' AND NOT EXISTS(SELECT 1 FROM organization_research_documents
    WHERE organization_id=workspace.organization_id AND source_kind='workspace_message' AND source_message_id=row_value.id) THEN RETURN row_value; END IF;
  SELECT revision INTO existing_revision FROM organization_research_documents
    WHERE organization_id=workspace.organization_id AND source_kind='workspace_message' AND source_message_id=row_value.id;
  INSERT INTO organization_research_documents(
    organization_id,account_workspace_id,source_kind,source_message_id,conversation_id,conversation_title,
    sender_user_id,sender_display_name,body,attachment_names_json,source_created_at,source_updated_at,revision,tombstone,tombstone_reason
  ) VALUES(workspace.organization_id,workspace.id,'workspace_message',row_value.id,
    COALESCE(NULLIF(row_value.payload_json->>'conversationId',''),NULLIF(row_value.payload_json->>'conversation_id',''),row_value.payload_json->>'sessionId',row_value.payload_json->>'session_id',''),
    COALESCE(row_value.payload_json->>'conversationTitle',row_value.payload_json->>'title',''),
    COALESCE(row_value.payload_json->>'senderUserId',row_value.payload_json->>'userId',row_value.user_id),
    COALESCE(NULLIF(row_value.payload_json->>'senderDisplayName',''),
      NULLIF(row_value.payload_json->>'sender_display_name',''),
      organization_research_sender_name(workspace.organization_id,
        COALESCE(row_value.payload_json->>'senderUserId',row_value.payload_json->>'userId',row_value.user_id)),''),
    CASE WHEN TG_OP='DELETE' THEN '' ELSE COALESCE(row_value.payload_json->>'content','') END,
    CASE WHEN TG_OP='DELETE' THEN '[]'::jsonb ELSE organization_research_attachment_names(row_value.payload_json) END,
    created_time,row_value.updated_at,COALESCE(existing_revision,0)+1,TG_OP='DELETE',CASE WHEN TG_OP='DELETE' THEN 'source_deleted' ELSE '' END)
  ON CONFLICT(organization_id,source_kind,source_message_id) DO UPDATE SET
    sender_display_name=excluded.sender_display_name,body=excluded.body,
    attachment_names_json=excluded.attachment_names_json,source_updated_at=excluded.source_updated_at,
    revision=excluded.revision,tombstone=excluded.tombstone,tombstone_reason=excluded.tombstone_reason,projected_at=now();
  RETURN row_value;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_project_organization_workspace_message ON cloud_messages_v6;
CREATE TRIGGER trg_project_organization_workspace_message
AFTER INSERT OR UPDATE OR DELETE ON cloud_messages_v6
FOR EACH ROW EXECUTE FUNCTION project_organization_workspace_message();

CREATE OR REPLACE FUNCTION revoke_organization_research_access() RETURNS trigger AS $$
DECLARE
  organization_key text := OLD.id;
BEGIN
  UPDATE organization_research_policies SET status='revoked',updated_at=now() WHERE organization_id=organization_key;
  UPDATE organization_research_device_leases SET status='revoked',revoked_at=now()
    WHERE organization_id=organization_key AND status='active';
  UPDATE organization_research_documents SET body='',attachment_names_json='[]'::jsonb,tombstone=true,
    tombstone_reason='organization_dissolved',revision=revision+1,projected_at=now()
    WHERE organization_id=organization_key AND tombstone=false;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_revoke_organization_research_access ON contact_organizations;
CREATE TRIGGER trg_revoke_organization_research_access
BEFORE DELETE ON contact_organizations
FOR EACH ROW EXECUTE FUNCTION revoke_organization_research_access();

CREATE OR REPLACE FUNCTION revoke_removed_member_research_leases() RETURNS trigger AS $$
BEGIN
  UPDATE organization_research_device_leases SET status='revoked',revoked_at=now()
    WHERE organization_id=OLD.organization_id AND user_id=OLD.user_id AND status='active';
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_revoke_removed_member_research_leases ON contact_organization_members;
CREATE TRIGGER trg_revoke_removed_member_research_leases
AFTER DELETE ON contact_organization_members
FOR EACH ROW EXECUTE FUNCTION revoke_removed_member_research_leases();
