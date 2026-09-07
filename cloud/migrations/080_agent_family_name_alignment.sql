-- requires-real-postgres: alias-family discovery and generated-name repair use PL/pgSQL and UPDATE ... FROM.
CREATE OR REPLACE FUNCTION janus_agent_family_alignment_sequence_label(input_value integer)
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

CREATE TEMP TABLE janus_agent_family_name_alignment_targets(
  id text PRIMARY KEY,
  previous_name text NOT NULL,
  target_name text NOT NULL
) ON COMMIT DROP;

INSERT INTO janus_agent_family_name_alignment_targets(id,previous_name,target_name)
SELECT id,name,CASE
  WHEN id='general_agent' OR name ~* '^(General Agent|通用 Agent)( [0-9]+)?$' THEN 'Generalist'
  WHEN id='ppt' OR name ~* '^(PPT Agent|PPTAgent)$' THEN 'PPT Designer'
END
FROM cloud_agent_families_v3
WHERE id IN ('general_agent','ppt')
  OR name ~* '^(General Agent|通用 Agent)( [0-9]+)?$'
  OR name ~* '^(PPT Agent|PPTAgent)$'
ON CONFLICT(id) DO NOTHING;

CREATE TEMP TABLE janus_agent_family_name_alignment_repairs(
  user_id text NOT NULL,
  id text NOT NULL,
  display_name text NOT NULL,
  PRIMARY KEY(user_id,id)
) ON COMMIT DROP;

INSERT INTO janus_agent_family_name_alignment_repairs(user_id,id,display_name)
SELECT instance.user_id,instance.id,
  target.target_name || ' ' || janus_agent_family_alignment_sequence_label(instance.family_instance_seq)
FROM cloud_user_agent_instances_v3 instance
JOIN janus_agent_family_name_alignment_targets target ON target.id=instance.agent_family_id
WHERE instance.family_instance_seq>0 AND (
  instance.display_name=''
  OR instance.display_name=target.previous_name || ' ' || janus_agent_family_alignment_sequence_label(instance.family_instance_seq)
  OR (target.target_name='Generalist' AND instance.display_name ~* (
    '^(General Agent|通用 Agent)( [0-9]+)? ' || janus_agent_family_alignment_sequence_label(instance.family_instance_seq) || '$'
  ))
  OR (target.target_name='PPT Designer' AND instance.display_name ~* (
    '^(PPT Agent|PPTAgent) ' || janus_agent_family_alignment_sequence_label(instance.family_instance_seq) || '$'
  ))
)
ON CONFLICT(user_id,id) DO NOTHING;

UPDATE cloud_agent_families_v3 family
SET name=target.target_name,
  payload_json=jsonb_set(COALESCE(family.payload_json,'{}'::jsonb),'{name}',to_jsonb(target.target_name),true),
  updated_at=now()
FROM janus_agent_family_name_alignment_targets target
WHERE target.id=family.id AND family.name<>target.target_name;

UPDATE cloud_user_agent_instances_v3 instance
SET display_name=repair.display_name,
  payload_json=jsonb_set(COALESCE(instance.payload_json,'{}'::jsonb),'{displayName}',to_jsonb(repair.display_name),true),
  state_revision=instance.state_revision+1,
  updated_at=now()
FROM janus_agent_family_name_alignment_repairs repair
WHERE repair.user_id=instance.user_id AND repair.id=instance.id
  AND instance.display_name<>repair.display_name;

UPDATE cloud_employee_roster_states state
SET roster_revision=roster_revision+1,updated_at=now()
WHERE EXISTS (
  SELECT 1 FROM janus_agent_family_name_alignment_repairs repair WHERE repair.user_id=state.user_id
);

DROP FUNCTION janus_agent_family_alignment_sequence_label(integer);
