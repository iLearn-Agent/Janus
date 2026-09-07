CREATE TABLE IF NOT EXISTS cloud_sync_reference_repairs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id text NOT NULL DEFAULT '',
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  repair_kind text NOT NULL,
  before_payload_json jsonb NOT NULL,
  after_payload_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  UNIQUE(user_id,entity_type,entity_id,repair_kind)
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_reference_repairs_user
  ON cloud_sync_reference_repairs(user_id,created_at,entity_type,entity_id);

-- requires-real-postgres-tail: production repair uses PL/pgSQL stable JSON hashing and JSONB lineage joins.
CREATE OR REPLACE FUNCTION janus_sync_stable_jsonb(value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  value_kind text := jsonb_typeof(value);
  serialized text;
BEGIN
  IF value_kind='object' THEN
    SELECT '{' || COALESCE(string_agg(to_jsonb(entry.key)::text || ':' || janus_sync_stable_jsonb(entry.value),',' ORDER BY entry.key COLLATE "C"),'') || '}'
      INTO serialized FROM jsonb_each(value) entry;
    RETURN serialized;
  ELSIF value_kind='array' THEN
    SELECT '[' || COALESCE(string_agg(janus_sync_stable_jsonb(entry.value),',' ORDER BY entry.ordinality),'') || ']'
      INTO serialized FROM jsonb_array_elements(value) WITH ORDINALITY entry(value,ordinality);
    RETURN serialized;
  END IF;
  RETURN value::text;
END;
$$;

WITH candidates AS (
  SELECT message.user_id,message.id,message.payload_json AS before_payload,
    jsonb_set(
      jsonb_set(
        message.payload_json,'{memoryId}',to_jsonb(context.memory_document_id),true
      ),
      '{memory_id}',to_jsonb(context.memory_document_id),true
    ) || jsonb_build_object('metadata',COALESCE(message.payload_json->'metadata','{}'::jsonb) || jsonb_build_object(
      'databaseRecovery',COALESCE(message.payload_json#>'{metadata,databaseRecovery}','{}'::jsonb) || jsonb_build_object(
        'orphanedMemoryId',COALESCE(NULLIF(message.payload_json->>'memoryId',''),message.payload_json->>'memory_id',''),
        'repairedMemoryId',context.memory_document_id,
        'migration','090_message_memory_turn_binding_repair.sql',
        'reason','context_owned_memory_rebind'
      )
    )) AS after_payload
  FROM cloud_messages_v6 message
  JOIN cloud_agent_context_spaces context
    ON context.user_id=message.user_id
    AND context.id=COALESCE(NULLIF(message.payload_json->>'contextSpaceId',''),message.payload_json->>'context_space_id')
    AND context.context_kind='general_memory' AND COALESCE(context.memory_document_id,'')!=''
  JOIN cloud_memory_documents_v3 memory
    ON memory.user_id=context.user_id AND memory.id=context.memory_document_id
    AND memory.user_agent_instance_id=context.user_agent_instance_id
  WHERE COALESCE(NULLIF(message.payload_json->>'memoryId',''),message.payload_json->>'memory_id','')!=''
    AND NOT EXISTS (
      SELECT 1 FROM cloud_memory_documents_v3 exact_memory
      WHERE exact_memory.user_id=message.user_id
        AND exact_memory.id=COALESCE(NULLIF(message.payload_json->>'memoryId',''),message.payload_json->>'memory_id')
    )
    AND NOT EXISTS (
      SELECT 1 FROM cloud_memory_sync_mappings mapping
      WHERE mapping.owner_user_id=message.user_id
        AND mapping.cloud_key=COALESCE(NULLIF(message.payload_json->>'memoryId',''),message.payload_json->>'memory_id')
    )
)
INSERT INTO cloud_sync_reference_repairs(
  id,user_id,account_id,entity_type,entity_id,repair_kind,before_payload_json,after_payload_json
)
SELECT 'sync_reference_repair_' || md5(user_id || E'\nmessage\n' || id || E'\ncontext_memory'),
  user_id,'account_personal_' || user_id,'message',id,'context_owned_memory_rebind',before_payload,after_payload
FROM candidates
ON CONFLICT(user_id,entity_type,entity_id,repair_kind) DO NOTHING;

UPDATE cloud_messages_v6 message
SET payload_json=repair.after_payload_json,updated_at=now()
FROM cloud_sync_reference_repairs repair
WHERE repair.user_id=message.user_id AND repair.entity_type='message'
  AND repair.entity_id=message.id AND repair.repair_kind='context_owned_memory_rebind'
  AND repair.applied_at IS NULL;

WITH turn_pairs AS (
  SELECT execution.user_id,execution.id AS execution_id,request.id AS request_id,response.id AS response_id,
    response.payload_json AS before_payload,
    COALESCE(NULLIF(request.payload_json->>'memoryId',''),request.payload_json->>'memory_id','') AS request_memory_id,
    COALESCE(NULLIF(request.payload_json->>'contextSpaceId',''),request.payload_json->>'context_space_id','') AS request_context_id,
    COALESCE(NULLIF(response.payload_json->>'memoryId',''),response.payload_json->>'memory_id','') AS response_memory_id,
    COALESCE(NULLIF(response.payload_json->>'contextSpaceId',''),response.payload_json->>'context_space_id','') AS response_context_id
  FROM cloud_model_executions_v6 execution
  JOIN cloud_messages_v6 request ON request.user_id=execution.user_id
    AND request.id=COALESCE(NULLIF(execution.payload_json->>'requestMessageId',''),execution.payload_json->>'request_message_id')
  JOIN cloud_messages_v6 response ON response.user_id=execution.user_id
    AND response.id=COALESCE(NULLIF(execution.payload_json->>'responseMessageId',''),execution.payload_json->>'response_message_id')
  JOIN cloud_agent_context_spaces context ON context.user_id=request.user_id
    AND context.id=COALESCE(NULLIF(request.payload_json->>'contextSpaceId',''),request.payload_json->>'context_space_id')
    AND context.memory_document_id=COALESCE(NULLIF(request.payload_json->>'memoryId',''),request.payload_json->>'memory_id')
  WHERE request.payload_json->>'role'='user' AND response.payload_json->>'role'='assistant'
    AND COALESCE(NULLIF(request.payload_json->>'memoryId',''),request.payload_json->>'memory_id','')!=''
    AND (
      COALESCE(NULLIF(response.payload_json->>'memoryId',''),response.payload_json->>'memory_id','')
        !=COALESCE(NULLIF(request.payload_json->>'memoryId',''),request.payload_json->>'memory_id','')
      OR COALESCE(NULLIF(response.payload_json->>'contextSpaceId',''),response.payload_json->>'context_space_id','')
        !=COALESCE(NULLIF(request.payload_json->>'contextSpaceId',''),request.payload_json->>'context_space_id','')
    )
), candidates AS (
  SELECT user_id,response_id,before_payload,
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(before_payload,'{memoryId}',to_jsonb(request_memory_id),true),
          '{memory_id}',to_jsonb(request_memory_id),true
        ),
        '{contextSpaceId}',to_jsonb(request_context_id),true
      ),
      '{context_space_id}',to_jsonb(request_context_id),true
    ) || jsonb_build_object('metadata',COALESCE(before_payload->'metadata','{}'::jsonb) || jsonb_build_object(
      'databaseRecovery',COALESCE(before_payload#>'{metadata,databaseRecovery}','{}'::jsonb) || jsonb_build_object(
        'previousMemoryId',response_memory_id,'previousContextSpaceId',response_context_id,
        'sourceRequestMessageId',request_id,'modelExecutionId',execution_id,
        'migration','090_message_memory_turn_binding_repair.sql','reason','turn_local_memory_binding'
      )
    )) AS after_payload
  FROM turn_pairs
)
INSERT INTO cloud_sync_reference_repairs(
  id,user_id,account_id,entity_type,entity_id,repair_kind,before_payload_json,after_payload_json
)
SELECT 'sync_reference_repair_' || md5(user_id || E'\nmessage\n' || response_id || E'\nturn_binding'),
  user_id,'account_personal_' || user_id,'message',response_id,'turn_local_memory_binding',before_payload,after_payload
FROM candidates
ON CONFLICT(user_id,entity_type,entity_id,repair_kind) DO NOTHING;

UPDATE cloud_messages_v6 message
SET payload_json=repair.after_payload_json,
  context_space_id=COALESCE(NULLIF(repair.after_payload_json->>'contextSpaceId',''),repair.after_payload_json->>'context_space_id',''),
  updated_at=now()
FROM cloud_sync_reference_repairs repair
WHERE repair.user_id=message.user_id AND repair.entity_type='message'
  AND repair.entity_id=message.id AND repair.repair_kind='turn_local_memory_binding'
  AND repair.applied_at IS NULL;

WITH unique_primary AS (
  SELECT user_id,
    COALESCE(NULLIF(payload_json->>'accountWorkspaceId',''),payload_json->>'account_workspace_id','workspace_personal') AS workspace_id,
    COALESCE(NULLIF(payload_json->>'agentInstanceId',''),payload_json->>'agent_instance_id') AS agent_instance_id,
    min(id) AS primary_id
  FROM cloud_conversations_v6
  WHERE conversation_role='primary' AND write_state='writable'
    AND COALESCE(payload_json->>'status','active')!='deleted'
    AND COALESCE(NULLIF(payload_json->>'agentInstanceId',''),payload_json->>'agent_instance_id','')!=''
  GROUP BY user_id,workspace_id,agent_instance_id HAVING count(*)=1
), candidates AS (
  SELECT conversation.user_id,conversation.id,conversation.payload_json AS before_payload,
    jsonb_set(
      jsonb_set(conversation.payload_json,'{supersededBySessionId}',to_jsonb(primary_row.primary_id),true),
      '{superseded_by_session_id}',to_jsonb(primary_row.primary_id),true
    ) AS after_payload,primary_row.primary_id
  FROM cloud_conversations_v6 conversation
  JOIN unique_primary primary_row ON primary_row.user_id=conversation.user_id
    AND primary_row.workspace_id=COALESCE(NULLIF(conversation.payload_json->>'accountWorkspaceId',''),conversation.payload_json->>'account_workspace_id','workspace_personal')
    AND primary_row.agent_instance_id=COALESCE(NULLIF(conversation.payload_json->>'agentInstanceId',''),conversation.payload_json->>'agent_instance_id')
  WHERE conversation.conversation_role='history' AND conversation.write_state='read_only'
    AND COALESCE(conversation.superseded_by_session_id,'')!=primary_row.primary_id
)
INSERT INTO cloud_sync_reference_repairs(
  id,user_id,account_id,entity_type,entity_id,repair_kind,before_payload_json,after_payload_json
)
SELECT 'sync_reference_repair_' || md5(user_id || E'\nconversation\n' || id || E'\nprimary'),
  user_id,'account_personal_' || user_id,'conversation',id,'history_primary_rebind',before_payload,after_payload
FROM candidates
ON CONFLICT(user_id,entity_type,entity_id,repair_kind) DO NOTHING;

UPDATE cloud_conversations_v6 conversation
SET payload_json=repair.after_payload_json,
  superseded_by_session_id=COALESCE(NULLIF(repair.after_payload_json->>'supersededBySessionId',''),repair.after_payload_json->>'superseded_by_session_id',''),
  updated_at=now()
FROM cloud_sync_reference_repairs repair
WHERE repair.user_id=conversation.user_id AND repair.entity_type='conversation'
  AND repair.entity_id=conversation.id AND repair.repair_kind='history_primary_rebind'
  AND repair.applied_at IS NULL;

WITH unique_primary AS (
  SELECT user_id,
    COALESCE(NULLIF(payload_json->>'agentInstanceId',''),payload_json->>'agent_instance_id') AS agent_instance_id,
    min(id) AS primary_id
  FROM cloud_conversations_v6
  WHERE conversation_role='primary' AND write_state='writable'
    AND COALESCE(payload_json->>'status','active')!='deleted'
  GROUP BY user_id,agent_instance_id HAVING count(*)=1
), candidates AS (
  SELECT state.owner_user_id AS user_id,state.user_agent_instance_id AS id,
    COALESCE(entity.payload_json,to_jsonb(state)) AS before_payload,
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(COALESCE(entity.payload_json,to_jsonb(state)),'{primaryConversationId}',to_jsonb(primary_row.primary_id),true),
            '{primary_conversation_id}',to_jsonb(primary_row.primary_id),true
          ),
          '{baseStateRevision}',to_jsonb(state.state_revision),true
        ),
        '{base_state_revision}',to_jsonb(state.state_revision),true
      ),
      '{stateRevision}',to_jsonb(state.state_revision+1),true
    ) || jsonb_build_object(
      'state_revision',state.state_revision+1,
      'sourceDeviceId','cloud_reference_repair_v2',
      'source_device_id','cloud_reference_repair_v2'
    ) AS after_payload
  FROM cloud_agent_context_states state
  JOIN unique_primary primary_row ON primary_row.user_id=state.owner_user_id
    AND primary_row.agent_instance_id=state.user_agent_instance_id
  LEFT JOIN cloud_conversations_v6 current ON current.user_id=state.owner_user_id AND current.id=state.primary_conversation_id
  LEFT JOIN cloud_sync_entities_v6 entity ON entity.user_id=state.owner_user_id
    AND entity.entity_type='agent_context_state' AND entity.entity_id=state.user_agent_instance_id
  WHERE COALESCE(state.primary_conversation_id,'')='' OR current.id IS NULL
    OR current.conversation_role!='primary' OR current.write_state!='writable'
)
INSERT INTO cloud_sync_reference_repairs(
  id,user_id,account_id,entity_type,entity_id,repair_kind,before_payload_json,after_payload_json
)
SELECT 'sync_reference_repair_' || md5(user_id || E'\nagent_context_state\n' || id || E'\nprimary'),
  user_id,'account_personal_' || user_id,'agent_context_state',id,'context_primary_rebind',before_payload,after_payload
FROM candidates
ON CONFLICT(user_id,entity_type,entity_id,repair_kind) DO NOTHING;

UPDATE cloud_agent_context_states state
SET primary_conversation_id=repair.after_payload_json->>'primary_conversation_id',
  state_revision=GREATEST(state.state_revision+1,(repair.after_payload_json->>'state_revision')::bigint),
  source_device_id='cloud_reference_repair_v2',updated_at=now()
FROM cloud_sync_reference_repairs repair
WHERE repair.user_id=state.owner_user_id AND repair.entity_type='agent_context_state'
  AND repair.entity_id=state.user_agent_instance_id AND repair.repair_kind='context_primary_rebind'
  AND repair.applied_at IS NULL;

WITH repaired_entities AS (
  SELECT DISTINCT repair.user_id,repair.entity_type,repair.entity_id,
    CASE repair.entity_type
      WHEN 'message' THEN message.payload_json
      WHEN 'conversation' THEN conversation.payload_json
      ELSE repair.after_payload_json
    END AS final_payload
  FROM cloud_sync_reference_repairs repair
  LEFT JOIN cloud_messages_v6 message ON repair.entity_type='message'
    AND message.user_id=repair.user_id AND message.id=repair.entity_id
  LEFT JOIN cloud_conversations_v6 conversation ON repair.entity_type='conversation'
    AND conversation.user_id=repair.user_id AND conversation.id=repair.entity_id
  WHERE repair.applied_at IS NULL
)
UPDATE cloud_sync_entities_v6 entity
SET payload_json=repair.final_payload,revision=entity.revision+1,
  content_hash=encode(sha256(convert_to(janus_sync_stable_jsonb(repair.final_payload),'UTF8')),'hex'),
  origin_device_id='cloud_reference_repair_v2',
  occurred_at=now(),updated_at=now()
FROM repaired_entities repair
WHERE repair.user_id=entity.user_id AND repair.entity_type=entity.entity_type
  AND repair.entity_id=entity.entity_id AND entity.payload_json IS DISTINCT FROM repair.final_payload;

UPDATE cloud_messages_v6 message
SET revision=entity.revision
FROM cloud_sync_entities_v6 entity
WHERE entity.user_id=message.user_id AND entity.entity_type='message' AND entity.entity_id=message.id
  AND EXISTS (SELECT 1 FROM cloud_sync_reference_repairs repair
    WHERE repair.user_id=message.user_id AND repair.entity_type='message'
      AND repair.entity_id=message.id AND repair.applied_at IS NULL);

UPDATE cloud_conversations_v6 conversation
SET revision=entity.revision
FROM cloud_sync_entities_v6 entity
WHERE entity.user_id=conversation.user_id AND entity.entity_type='conversation' AND entity.entity_id=conversation.id
  AND EXISTS (SELECT 1 FROM cloud_sync_reference_repairs repair
    WHERE repair.user_id=conversation.user_id AND repair.entity_type='conversation'
      AND repair.entity_id=conversation.id AND repair.applied_at IS NULL);

WITH repaired_entities AS (
  SELECT DISTINCT repair.user_id,repair.entity_type,repair.entity_id,
    CASE repair.entity_type
      WHEN 'message' THEN message.payload_json
      WHEN 'conversation' THEN conversation.payload_json
      ELSE repair.after_payload_json
    END AS final_payload
  FROM cloud_sync_reference_repairs repair
  LEFT JOIN cloud_messages_v6 message ON repair.entity_type='message'
    AND message.user_id=repair.user_id AND message.id=repair.entity_id
  LEFT JOIN cloud_conversations_v6 conversation ON repair.entity_type='conversation'
    AND conversation.user_id=repair.user_id AND conversation.id=repair.entity_id
  WHERE repair.applied_at IS NULL
)
UPDATE cloud_sync_entities_v8 entity
SET payload_json=repair.final_payload,revision=entity.revision+1,
  content_hash=encode(sha256(convert_to(janus_sync_stable_jsonb(repair.final_payload),'UTF8')),'hex'),
  origin_user_id=repair.user_id,
  origin_device_id='cloud_reference_repair_v2',occurred_at=now(),updated_at=now()
FROM repaired_entities repair
WHERE repair.entity_type=entity.entity_type AND repair.entity_id=entity.entity_id
  AND entity.origin_user_id=repair.user_id AND entity.payload_json IS DISTINCT FROM repair.final_payload;

INSERT INTO cloud_sync_batches_v6(
  id,user_id,device_id,item_count,payload_hash,status,created_at
)
SELECT 'sync_batch_reference_repair_v2_' || md5(user_id),user_id,'cloud_reference_repair_v2',count(*),
  md5(user_id || E'\nmessage_memory_turn_binding_repair_v2'),'accepted',now()
FROM (SELECT DISTINCT user_id,entity_type,entity_id FROM cloud_sync_reference_repairs
  WHERE applied_at IS NULL) repair GROUP BY user_id
ON CONFLICT(user_id,device_id,payload_hash) DO NOTHING;

INSERT INTO cloud_sync_batches_v8(
  id,account_id,user_id,device_id,item_count,payload_hash,status,created_at
)
SELECT 'sync_batch_reference_repair_v2_' || md5(entity.account_id || E'\n' || repair.user_id),
  entity.account_id,repair.user_id,'cloud_reference_repair_v2',count(*),
  md5(entity.account_id || E'\n' || repair.user_id || E'\nmessage_memory_turn_binding_repair_v2'),'accepted',now()
FROM (SELECT DISTINCT user_id,entity_type,entity_id FROM cloud_sync_reference_repairs
  WHERE applied_at IS NULL) repair
JOIN cloud_sync_entities_v8 entity ON entity.origin_user_id=repair.user_id
  AND entity.entity_type=repair.entity_type AND entity.entity_id=repair.entity_id
GROUP BY entity.account_id,repair.user_id
ON CONFLICT(account_id,user_id,device_id,payload_hash) DO NOTHING;

INSERT INTO cloud_sync_changes_v6(
  change_id,user_id,device_id,batch_id,entity_type,entity_id,operation,
  base_revision,revision,content_hash,payload_json,occurred_at,accepted_at
)
SELECT 'change_reference_repair_v2_' || md5(entity.user_id || E'\n' || entity.entity_type || E'\n' || entity.entity_id),
  entity.user_id,'cloud_reference_repair_v2','sync_batch_reference_repair_v2_' || md5(entity.user_id),
  entity.entity_type,entity.entity_id,'upsert',GREATEST(0,entity.revision-1),entity.revision,
  entity.content_hash,entity.payload_json,entity.occurred_at,now()
FROM cloud_sync_entities_v6 entity
WHERE EXISTS (SELECT 1 FROM cloud_sync_reference_repairs repair
  WHERE repair.user_id=entity.user_id AND repair.entity_type=entity.entity_type
    AND repair.entity_id=entity.entity_id AND repair.applied_at IS NULL)
ON CONFLICT(change_id) DO NOTHING;

INSERT INTO cloud_sync_changes_v8(
  change_id,account_id,user_id,device_id,batch_id,entity_type,entity_id,operation,
  base_revision,revision,content_hash,payload_json,occurred_at,accepted_at
)
SELECT 'change_reference_repair_v2_' || md5(entity.account_id || E'\n' || entity.entity_type || E'\n' || entity.entity_id),
  entity.account_id,repair.user_id,'cloud_reference_repair_v2',
  'sync_batch_reference_repair_v2_' || md5(entity.account_id || E'\n' || repair.user_id),
  entity.entity_type,entity.entity_id,'upsert',GREATEST(0,entity.revision-1),entity.revision,
  entity.content_hash,entity.payload_json,entity.occurred_at,now()
FROM cloud_sync_entities_v8 entity
JOIN (SELECT DISTINCT user_id,entity_type,entity_id FROM cloud_sync_reference_repairs
  WHERE applied_at IS NULL) repair ON repair.user_id=entity.origin_user_id
  AND repair.entity_type=entity.entity_type AND repair.entity_id=entity.entity_id
ON CONFLICT(change_id) DO NOTHING;

UPDATE cloud_sync_snapshots_v7 snapshot
SET entities_json=COALESCE((
  SELECT jsonb_agg(CASE WHEN repair.entity_id IS NULL THEN item ELSE item || jsonb_build_object(
    'revision',entity.revision,'baseRevision',GREATEST(0,entity.revision-1),
    'contentHash',entity.content_hash,'payload',entity.payload_json
  ) || CASE WHEN repair.entity_type='message' THEN jsonb_build_object(
    'requiredCapabilities','["account-owned-agent-v1","account-principal-isolation-v1","account-scoped-cursor-v1","account-workspace-v2","agent-single-window-continuity-v1","canonical-agent-identity-v1","conversation-identity-phase6","conversation-security-domain-v1","janus-clean-slate-v1","message-memory-turn-binding-v1","staged-sync-v6"]'::jsonb
  ) ELSE '{}'::jsonb END
  END ORDER BY item->>'entityType',item->>'entityId')
  FROM jsonb_array_elements(snapshot.entities_json) item
  LEFT JOIN (SELECT DISTINCT user_id,entity_type,entity_id FROM cloud_sync_reference_repairs
    WHERE applied_at IS NULL) repair ON repair.user_id=snapshot.user_id
    AND repair.entity_type=item->>'entityType' AND repair.entity_id=item->>'entityId'
  LEFT JOIN cloud_sync_entities_v6 entity ON entity.user_id=snapshot.user_id
    AND entity.entity_type=item->>'entityType' AND entity.entity_id=item->>'entityId'
),'[]'::jsonb),updated_at=now()
WHERE EXISTS (SELECT 1 FROM cloud_sync_reference_repairs repair
  WHERE repair.user_id=snapshot.user_id AND repair.applied_at IS NULL);

UPDATE cloud_sync_snapshots_v8 snapshot
SET entities_json=COALESCE((
  SELECT jsonb_agg(CASE WHEN repair.entity_id IS NULL THEN item ELSE item || jsonb_build_object(
    'revision',entity.revision,'baseRevision',GREATEST(0,entity.revision-1),
    'contentHash',entity.content_hash,'payload',entity.payload_json
  ) || CASE WHEN repair.entity_type='message' THEN jsonb_build_object(
    'requiredCapabilities','["account-owned-agent-v1","account-principal-isolation-v1","account-scoped-cursor-v1","account-workspace-v2","agent-single-window-continuity-v1","canonical-agent-identity-v1","conversation-identity-phase6","conversation-security-domain-v1","janus-clean-slate-v1","message-memory-turn-binding-v1","staged-sync-v6"]'::jsonb
  ) ELSE '{}'::jsonb END
  END ORDER BY item->>'entityType',item->>'entityId')
  FROM jsonb_array_elements(snapshot.entities_json) item
  LEFT JOIN cloud_sync_entities_v8 entity ON entity.account_id=snapshot.account_id
    AND entity.entity_type=item->>'entityType' AND entity.entity_id=item->>'entityId'
  LEFT JOIN (SELECT DISTINCT user_id,entity_type,entity_id FROM cloud_sync_reference_repairs
    WHERE applied_at IS NULL) repair ON repair.user_id=entity.origin_user_id
    AND repair.entity_type=item->>'entityType' AND repair.entity_id=item->>'entityId'
),'[]'::jsonb),updated_at=now()
WHERE EXISTS (SELECT 1 FROM cloud_sync_entities_v8 entity
  JOIN (SELECT DISTINCT user_id,entity_type,entity_id FROM cloud_sync_reference_repairs
    WHERE applied_at IS NULL) repair ON repair.user_id=entity.origin_user_id
    AND repair.entity_type=entity.entity_type AND repair.entity_id=entity.entity_id
  WHERE entity.account_id=snapshot.account_id);

UPDATE cloud_sync_reference_repairs SET applied_at=now() WHERE applied_at IS NULL;

DROP FUNCTION janus_sync_stable_jsonb(jsonb);
