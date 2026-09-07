ALTER TABLE cloud_user_agent_instances_v3
  DROP CONSTRAINT IF EXISTS cloud_user_agent_instances_v3_user_id_agent_family_id_key;

CREATE INDEX IF NOT EXISTS idx_cloud_user_agent_instances_family
  ON cloud_user_agent_instances_v3(user_id,agent_family_id,created_at,id);
