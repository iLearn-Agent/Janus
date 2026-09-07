-- Stages 1-3 contract closure: account-wide context state, primary conversation
-- backfill, canonical current Memory, and mandatory active+synced cluster policy.

-- pg-mem compatibility prefix. Real PostgreSQL continues below and performs the
-- window-function backfills plus authority constraint installation.
CREATE TABLE IF NOT EXISTS cloud_agent_context_states (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL,
  primary_conversation_id text NOT NULL DEFAULT '',
  active_context_space_id text NOT NULL DEFAULT '',
  active_memory_document_id text NOT NULL DEFAULT '',
  state_revision bigint NOT NULL DEFAULT 1,
  last_command_id text NOT NULL DEFAULT '',
  source_device_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id,user_agent_instance_id),
  FOREIGN KEY(owner_user_id,user_agent_instance_id)
    REFERENCES cloud_user_agent_instances_v3(user_id,id) ON DELETE CASCADE,
  CHECK(state_revision>=1)
);
CREATE INDEX IF NOT EXISTS idx_cloud_agent_context_states_updated
  ON cloud_agent_context_states(owner_user_id,updated_at,user_agent_instance_id);

-- requires-real-postgres-tail: pg-mem does not implement the window-function backfills below.

UPDATE cloud_conversations_v6
SET conversation_role='history',write_state='read_only',superseded_by_session_id=''
WHERE COALESCE(payload_json->>'agentInstanceId',payload_json->>'agent_instance_id','')<>'';

WITH ranked AS (
  SELECT user_id,id,
    FIRST_VALUE(id) OVER (
      PARTITION BY user_id,COALESCE(payload_json->>'agentInstanceId',payload_json->>'agent_instance_id')
      ORDER BY updated_at DESC,id DESC
    ) AS winner,
    ROW_NUMBER() OVER (
      PARTITION BY user_id,COALESCE(payload_json->>'agentInstanceId',payload_json->>'agent_instance_id')
      ORDER BY updated_at DESC,id DESC
    ) AS row_no
  FROM cloud_conversations_v6
  WHERE COALESCE(payload_json->>'agentInstanceId',payload_json->>'agent_instance_id','')<>''
    AND COALESCE(payload_json->>'status','active')<>'deleted'
)
UPDATE cloud_conversations_v6 c SET
  conversation_role=CASE WHEN r.row_no=1 THEN 'primary' ELSE 'history' END,
  write_state=CASE WHEN r.row_no=1 THEN 'writable' ELSE 'read_only' END,
  superseded_by_session_id=CASE WHEN r.row_no=1 THEN '' ELSE r.winner END
FROM ranked r WHERE c.user_id=r.user_id AND c.id=r.id;

WITH ranked AS (
  SELECT user_id,id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id,user_agent_instance_id
      ORDER BY updated_at DESC,slot_no DESC,id DESC
    ) AS row_no
  FROM cloud_memory_documents_v3
  WHERE scope='general' AND lifecycle_state='active'
)
UPDATE cloud_memory_documents_v3 d SET lifecycle_state='inactive'
FROM ranked r
WHERE d.user_id=r.user_id AND d.id=r.id AND r.row_no>1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_one_active_general_memory
  ON cloud_memory_documents_v3(user_id,user_agent_instance_id)
  WHERE scope='general' AND lifecycle_state='active';

CREATE TABLE IF NOT EXISTS cloud_agent_context_states (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL,
  primary_conversation_id text NOT NULL DEFAULT '',
  active_context_space_id text NOT NULL DEFAULT '',
  active_memory_document_id text NOT NULL DEFAULT '',
  state_revision bigint NOT NULL DEFAULT 1,
  last_command_id text NOT NULL DEFAULT '',
  source_device_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id,user_agent_instance_id),
  FOREIGN KEY(owner_user_id,user_agent_instance_id)
    REFERENCES cloud_user_agent_instances_v3(user_id,id) ON DELETE CASCADE,
  CHECK(state_revision>=1)
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_context_states_updated
  ON cloud_agent_context_states(owner_user_id,updated_at,user_agent_instance_id);

INSERT INTO cloud_agent_context_states(
  owner_user_id,user_agent_instance_id,primary_conversation_id,
  active_context_space_id,active_memory_document_id,state_revision,last_command_id
)
SELECT i.user_id,i.id,
  COALESCE((SELECT c.id FROM cloud_conversations_v6 c
    WHERE c.user_id=i.user_id AND c.conversation_role='primary' AND c.write_state='writable'
      AND COALESCE(c.payload_json->>'agentInstanceId',c.payload_json->>'agent_instance_id','')=i.id
    ORDER BY c.updated_at DESC,c.id DESC LIMIT 1),''),
  COALESCE((SELECT s.id FROM cloud_agent_context_spaces s
    JOIN cloud_memory_documents_v3 d ON d.user_id=s.user_id AND d.id=s.memory_document_id
    WHERE s.user_id=i.user_id AND s.user_agent_instance_id=i.id
      AND s.context_kind='general_memory' AND d.scope='general' AND d.lifecycle_state='active'
    ORDER BY d.updated_at DESC,d.slot_no DESC,d.id DESC LIMIT 1),''),
  COALESCE((SELECT d.id FROM cloud_memory_documents_v3 d
    WHERE d.user_id=i.user_id AND d.user_agent_instance_id=i.id
      AND d.scope='general' AND d.lifecycle_state='active'
    ORDER BY d.updated_at DESC,d.slot_no DESC,d.id DESC LIMIT 1),''),
  1,'migration_040'
FROM cloud_user_agent_instances_v3 i
ON CONFLICT(owner_user_id,user_agent_instance_id) DO NOTHING;

UPDATE cloud_user_agent_instances_v3 SET
  cluster_contribution_consent=(sync_enabled AND status='active');

UPDATE cloud_memory_documents_v3 d SET
  allow_personal_evolution=i.personal_evolution_consent,
  allow_cluster_evolution=(i.sync_enabled AND i.status='active'),
  sync_enabled=i.sync_enabled
FROM cloud_user_agent_instances_v3 i
WHERE i.user_id=d.user_id AND i.id=d.user_agent_instance_id;

-- requires-real-postgres-tail: trigger functions, named constraints, and grants are not supported by pg-mem.
CREATE OR REPLACE FUNCTION janus_set_cluster_participation_authority()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.cluster_contribution_consent=(NEW.sync_enabled AND NEW.status='active');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_cloud_cluster_participation_authority ON cloud_user_agent_instances_v3;
CREATE TRIGGER trg_cloud_cluster_participation_authority
BEFORE INSERT OR UPDATE OF sync_enabled,status,cluster_contribution_consent ON cloud_user_agent_instances_v3
FOR EACH ROW EXECUTE FUNCTION janus_set_cluster_participation_authority();

ALTER TABLE cloud_user_agent_instances_v3
  DROP CONSTRAINT IF EXISTS chk_cloud_cluster_participation_authority;
ALTER TABLE cloud_user_agent_instances_v3
  ADD CONSTRAINT chk_cloud_cluster_participation_authority CHECK(
    cluster_contribution_consent=(sync_enabled AND status='active')
  );

GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_agent_context_states TO janus_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_agent_context_states TO janus_evolution_worker;
