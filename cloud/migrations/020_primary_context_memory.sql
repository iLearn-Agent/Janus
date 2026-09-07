ALTER TABLE cloud_conversations_v6 ADD COLUMN IF NOT EXISTS conversation_role text NOT NULL DEFAULT 'standard';
ALTER TABLE cloud_conversations_v6 ADD COLUMN IF NOT EXISTS write_state text NOT NULL DEFAULT 'writable';
ALTER TABLE cloud_conversations_v6 ADD COLUMN IF NOT EXISTS superseded_by_session_id text NOT NULL DEFAULT '';

ALTER TABLE cloud_messages_v6 ADD COLUMN IF NOT EXISTS context_space_id text NOT NULL DEFAULT '';

ALTER TABLE cloud_memory_documents_v3 ADD COLUMN IF NOT EXISTS agent_family_id text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_documents_v3 ADD COLUMN IF NOT EXISTS cloud_key text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_documents_v3 ADD COLUMN IF NOT EXISTS delegation_id text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_documents_v3 ADD COLUMN IF NOT EXISTS group_id text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_documents_v3 ADD COLUMN IF NOT EXISTS relationship_user_id text NOT NULL DEFAULT '';

ALTER TABLE cloud_memory_document_versions_v3 ADD COLUMN IF NOT EXISTS base_version_id text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_document_versions_v3 ADD COLUMN IF NOT EXISTS parent_version_id text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_document_versions_v3 ADD COLUMN IF NOT EXISTS branch_id text NOT NULL DEFAULT 'main';
ALTER TABLE cloud_memory_document_versions_v3 ADD COLUMN IF NOT EXISTS conflict_state text NOT NULL DEFAULT 'none';

UPDATE cloud_memory_documents_v3 SET cloud_key=id WHERE cloud_key='';

CREATE TABLE IF NOT EXISTS cloud_agent_context_spaces (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  user_agent_instance_id text NOT NULL,
  context_kind text NOT NULL,
  memory_document_id text,
  project_id text NOT NULL DEFAULT '',
  task_run_id text NOT NULL DEFAULT '',
  delegation_id text NOT NULL DEFAULT '',
  group_id text NOT NULL DEFAULT '',
  relationship_user_id text NOT NULL DEFAULT '',
  lifecycle_state text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_context_identity
  ON cloud_agent_context_spaces(user_id,user_agent_instance_id,context_kind,COALESCE(memory_document_id,''),project_id,task_run_id,delegation_id,group_id,relationship_user_id);

CREATE TABLE IF NOT EXISTS cloud_memory_sync_mappings (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL,
  cloud_key text NOT NULL,
  memory_document_id text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id,user_agent_instance_id,cloud_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_memory_mapping_active_document
  ON cloud_memory_sync_mappings(owner_user_id,memory_document_id) WHERE status='active';

ALTER TABLE cloud_memory_access_audits ADD COLUMN IF NOT EXISTS requester_user_id text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_access_audits ADD COLUMN IF NOT EXISTS requester_agent_instance_id text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_access_audits ADD COLUMN IF NOT EXISTS target_agent_instance_id text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_access_audits ADD COLUMN IF NOT EXISTS context_space_id text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_access_audits ADD COLUMN IF NOT EXISTS task_run_id text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_access_audits ADD COLUMN IF NOT EXISTS memory_cloud_key text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_access_audits ADD COLUMN IF NOT EXISTS memory_document_version_id text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_access_audits ADD COLUMN IF NOT EXISTS action text NOT NULL DEFAULT 'evolution_read';
ALTER TABLE cloud_memory_access_audits ADD COLUMN IF NOT EXISTS requested_reason text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_access_audits ADD COLUMN IF NOT EXISTS result_code text NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_one_primary_agent_conversation
  ON cloud_conversations_v6(user_id,((payload_json->>'agentInstanceId')))
  WHERE conversation_role='primary' AND write_state='writable' AND COALESCE(payload_json->>'agentInstanceId','')!='';
