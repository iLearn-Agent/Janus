ALTER TABLE cloud_memory_documents_v3 ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT 'memory0.md';
ALTER TABLE cloud_memory_documents_v3 ADD COLUMN IF NOT EXISTS task_run_id text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_documents_v3 ADD COLUMN IF NOT EXISTS project_id text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_documents_v3 ADD COLUMN IF NOT EXISTS relationship_id text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_documents_v3 ADD COLUMN IF NOT EXISTS context_space_id text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_documents_v3 ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';
ALTER TABLE cloud_memory_documents_v3 ADD COLUMN IF NOT EXISTS source_conversation_cursor text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_documents_v3 ADD COLUMN IF NOT EXISTS encryption_key_id text NOT NULL DEFAULT '';
ALTER TABLE cloud_memory_documents_v3 ADD COLUMN IF NOT EXISTS consent_scope_json jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_cloud_memory_documents_context_v5
  ON cloud_memory_documents_v3(user_id,user_agent_instance_id,scope,task_run_id,project_id,relationship_id,updated_at);

CREATE TABLE IF NOT EXISTS cloud_task_security_contexts_v5 (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_run_id text NOT NULL,
  owner_user_id text NOT NULL DEFAULT '',
  local_key_id text NOT NULL,
  cloud_key_id text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  cloud_evolution_allowed boolean NOT NULL DEFAULT false,
  cloud_collaboration_allowed boolean NOT NULL DEFAULT false,
  local_envelope_state text NOT NULL DEFAULT 'reference_only',
  cloud_envelope_state text NOT NULL DEFAULT 'disabled',
  status text NOT NULL DEFAULT 'active',
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,task_run_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_task_security_owner_v5
  ON cloud_task_security_contexts_v5(user_id,owner_user_id,status,updated_at);
