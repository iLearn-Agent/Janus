-- requires-real-postgres: generated display-name repair uses PL/pgSQL and UPDATE ... FROM.
CREATE OR REPLACE FUNCTION janus_agent_display_sequence_label(input_value integer)
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

CREATE TEMP TABLE janus_agent_display_name_repairs(
  user_id text NOT NULL,
  id text NOT NULL,
  display_name text NOT NULL,
  PRIMARY KEY(user_id,id)
) ON COMMIT DROP;

INSERT INTO janus_agent_display_name_repairs(user_id,id,display_name)
SELECT instance.user_id,instance.id,
  CASE instance.agent_family_id
    WHEN 'general_agent' THEN 'Generalist ' || janus_agent_display_sequence_label(instance.family_instance_seq)
    WHEN 'ppt' THEN 'PPT Designer ' || janus_agent_display_sequence_label(instance.family_instance_seq)
  END
FROM cloud_user_agent_instances_v3 instance
WHERE instance.family_instance_seq>0 AND (
  (instance.agent_family_id='general_agent' AND (
    instance.display_name=''
    OR instance.display_name='通用 Agent ' || janus_agent_display_sequence_label(instance.family_instance_seq)
    OR instance.display_name='General Agent ' || janus_agent_display_sequence_label(instance.family_instance_seq)
    OR instance.display_name ~ '^通用 Agent [123]( [A-Z]+)?$'
  ))
  OR (instance.agent_family_id='ppt' AND (
    instance.display_name=''
    OR instance.display_name='PPT Agent ' || janus_agent_display_sequence_label(instance.family_instance_seq)
  ))
)
ON CONFLICT(user_id,id) DO NOTHING;

UPDATE cloud_agent_families_v3
SET name=CASE id WHEN 'general_agent' THEN 'Generalist' WHEN 'ppt' THEN 'PPT Designer' END,
  payload_json=jsonb_set(COALESCE(payload_json,'{}'::jsonb),'{name}',
    to_jsonb(CASE id WHEN 'general_agent' THEN 'Generalist' WHEN 'ppt' THEN 'PPT Designer' END),true),
  updated_at=now()
WHERE id IN ('general_agent','ppt')
  AND name<>CASE id WHEN 'general_agent' THEN 'Generalist' WHEN 'ppt' THEN 'PPT Designer' END;

UPDATE cloud_user_agent_instances_v3 instance
SET display_name=repair.display_name,
  payload_json=jsonb_set(COALESCE(instance.payload_json,'{}'::jsonb),'{displayName}',to_jsonb(repair.display_name),true),
  state_revision=instance.state_revision+1,
  updated_at=now()
FROM janus_agent_display_name_repairs repair
WHERE repair.user_id=instance.user_id AND repair.id=instance.id
  AND instance.display_name<>repair.display_name;

UPDATE cloud_employee_roster_states state
SET roster_revision=roster_revision+1,updated_at=now()
WHERE EXISTS (
  SELECT 1 FROM janus_agent_display_name_repairs repair WHERE repair.user_id=state.user_id
);

DROP FUNCTION janus_agent_display_sequence_label(integer);
