-- requires-real-postgres: contiguous sequence repair uses window functions, temporary tables, and UPDATE ... FROM.
CREATE OR REPLACE FUNCTION janus_agent_compaction_sequence_label(input_value integer)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE value integer := GREATEST(1,input_value); result text := '';
BEGIN
  WHILE value>0 LOOP
    value := value-1;
    result := chr(65+(value%26)) || result;
    value := floor(value/26);
  END LOOP;
  RETURN result;
END $$;

DROP INDEX IF EXISTS idx_cloud_user_agent_instances_unique_family_seq;

CREATE TEMP TABLE janus_agent_instance_sequence_compaction(
  user_id text NOT NULL,
  id text NOT NULL,
  target_sequence integer NOT NULL,
  target_display_name text NOT NULL,
  PRIMARY KEY(user_id,id)
) ON COMMIT DROP;

WITH canonical_instances AS (
  SELECT instance.*,
    row_number() OVER (
      PARTITION BY instance.user_id,instance.agent_family_id
      ORDER BY instance.recruited_at,instance.created_at,instance.id
    )::integer AS target_sequence,
    family.name AS family_name
  FROM cloud_user_agent_instances_v3 instance
  JOIN cloud_agent_families_v3 family ON family.id=instance.agent_family_id
  WHERE instance.instance_kind='employee'
    AND NOT EXISTS (
      SELECT 1 FROM cloud_user_agent_instance_aliases_v3 alias
      WHERE alias.user_id=instance.user_id AND alias.alias_instance_id=instance.id
    )
), projected AS (
  SELECT user_id,id,target_sequence,
    CASE WHEN display_name=''
      OR display_name=family_name || ' ' || janus_agent_compaction_sequence_label(GREATEST(family_instance_seq,1))
      OR display_name ~* ('^(Generalist|General Agent|通用 Agent)( [0-9]+)? '
        || janus_agent_compaction_sequence_label(GREATEST(family_instance_seq,1)) || '$')
      OR display_name ~* ('^(PPT Designer|PPT Agent|PPTAgent) '
        || janus_agent_compaction_sequence_label(GREATEST(family_instance_seq,1)) || '$')
      THEN family_name || ' ' || janus_agent_compaction_sequence_label(target_sequence)
      ELSE display_name END AS target_display_name
  FROM canonical_instances
)
INSERT INTO janus_agent_instance_sequence_compaction(user_id,id,target_sequence,target_display_name)
SELECT user_id,id,target_sequence,target_display_name FROM projected;

INSERT INTO janus_agent_instance_sequence_compaction(user_id,id,target_sequence,target_display_name)
SELECT instance.user_id,instance.id,0,instance.display_name
FROM cloud_user_agent_instances_v3 instance
WHERE instance.instance_kind='employee'
  AND EXISTS (
    SELECT 1 FROM cloud_user_agent_instance_aliases_v3 alias
    WHERE alias.user_id=instance.user_id AND alias.alias_instance_id=instance.id
  )
ON CONFLICT(user_id,id) DO NOTHING;

CREATE TEMP TABLE janus_agent_instance_sequence_compaction_users(
  user_id text PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO janus_agent_instance_sequence_compaction_users(user_id)
SELECT DISTINCT instance.user_id
FROM cloud_user_agent_instances_v3 instance
JOIN janus_agent_instance_sequence_compaction repair
  ON repair.user_id=instance.user_id AND repair.id=instance.id
WHERE instance.family_instance_seq<>repair.target_sequence OR instance.display_name<>repair.target_display_name;

UPDATE cloud_user_agent_instances_v3 instance
SET family_instance_seq=repair.target_sequence,
  display_name=repair.target_display_name,
  payload_json=jsonb_set(
    jsonb_set(COALESCE(instance.payload_json,'{}'::jsonb),'{familyInstanceSeq}',to_jsonb(repair.target_sequence),true),
    '{displayName}',to_jsonb(repair.target_display_name),true),
  state_revision=instance.state_revision+1,
  updated_at=now()
FROM janus_agent_instance_sequence_compaction repair
WHERE repair.user_id=instance.user_id AND repair.id=instance.id
  AND (instance.family_instance_seq<>repair.target_sequence OR instance.display_name<>repair.target_display_name);

UPDATE cloud_employee_roster_states state
SET roster_revision=roster_revision+1,updated_at=now()
WHERE EXISTS (
  SELECT 1 FROM janus_agent_instance_sequence_compaction_users changed WHERE changed.user_id=state.user_id
);

CREATE UNIQUE INDEX idx_cloud_user_agent_instances_unique_family_seq
  ON cloud_user_agent_instances_v3(user_id,agent_family_id,family_instance_seq)
  WHERE family_instance_seq>0;

DROP FUNCTION janus_agent_compaction_sequence_label(integer);
