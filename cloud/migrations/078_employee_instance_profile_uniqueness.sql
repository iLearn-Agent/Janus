ALTER TABLE cloud_user_agent_instances_v3
  ADD COLUMN IF NOT EXISTS family_instance_seq integer NOT NULL DEFAULT 0;
ALTER TABLE cloud_user_agent_instances_v3
  ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '';
ALTER TABLE cloud_user_agent_instances_v3
  ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';

-- requires-real-postgres-tail: pg-mem cannot execute the windowed repair, temporary table, UPDATE ... FROM, or PL/pgSQL below.
UPDATE cloud_user_agent_instances_v3
SET family_instance_seq = CASE
      WHEN family_instance_seq > 0 THEN family_instance_seq
      WHEN COALESCE(payload_json->>'familyInstanceSeq','') ~ '^[0-9]+$'
        THEN (payload_json->>'familyInstanceSeq')::integer
      ELSE 0 END,
    display_name = CASE WHEN display_name<>'' THEN display_name ELSE COALESCE(payload_json->>'displayName','') END,
    note = CASE WHEN note<>'' THEN note ELSE COALESCE(payload_json->>'note','') END;

CREATE TEMP TABLE janus_employee_profile_repairs(
  user_id text NOT NULL,
  id text NOT NULL,
  next_sequence integer NOT NULL,
  PRIMARY KEY(user_id,id)
) ON COMMIT DROP;

WITH ranked AS (
  SELECT user_id,id,agent_family_id,family_instance_seq,created_at,
    row_number() OVER (
      PARTITION BY user_id,agent_family_id,family_instance_seq
      ORDER BY created_at,id
    ) AS duplicate_rank,
    max(GREATEST(family_instance_seq,0)) OVER (
      PARTITION BY user_id,agent_family_id
    ) AS maximum_sequence
  FROM cloud_user_agent_instances_v3
), repair_candidates AS (
  SELECT *,row_number() OVER (
    PARTITION BY user_id,agent_family_id ORDER BY created_at,id
  ) AS repair_ordinal
  FROM ranked
  WHERE family_instance_seq<=0 OR duplicate_rank>1
)
INSERT INTO janus_employee_profile_repairs(user_id,id,next_sequence)
SELECT user_id,id,maximum_sequence+repair_ordinal FROM repair_candidates;

UPDATE cloud_user_agent_instances_v3 instance
SET family_instance_seq=repair.next_sequence
FROM janus_employee_profile_repairs repair
WHERE repair.user_id=instance.user_id AND repair.id=instance.id;

CREATE OR REPLACE FUNCTION janus_agent_sequence_label(input_value integer)
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

INSERT INTO janus_employee_profile_repairs(user_id,id,next_sequence)
SELECT instance.user_id,instance.id,instance.family_instance_seq
FROM cloud_user_agent_instances_v3 instance
JOIN cloud_agent_families_v3 family ON family.id=instance.agent_family_id
WHERE instance.display_name=''
  OR ((left(instance.display_name,length(family.name)+1)=family.name || ' '
      AND substring(instance.display_name from length(family.name)+2) ~ '^[A-Z]+$')
    AND instance.display_name<>(family.name || ' ' || janus_agent_sequence_label(instance.family_instance_seq)))
  OR instance.display_name ~ '^通用 Agent [123]( [A-Z]+)?$'
ON CONFLICT(user_id,id) DO NOTHING;

UPDATE cloud_user_agent_instances_v3 instance
SET display_name=family.name || ' ' || janus_agent_sequence_label(instance.family_instance_seq)
FROM cloud_agent_families_v3 family
WHERE family.id=instance.agent_family_id
  AND (instance.display_name=''
    OR (left(instance.display_name,length(family.name)+1)=family.name || ' '
      AND substring(instance.display_name from length(family.name)+2) ~ '^[A-Z]+$')
    OR instance.display_name ~ '^通用 Agent [123]( [A-Z]+)?$');

UPDATE cloud_user_agent_instances_v3 instance
SET payload_json=jsonb_set(
      jsonb_set(
        jsonb_set(COALESCE(instance.payload_json,'{}'::jsonb),'{familyInstanceSeq}',to_jsonb(instance.family_instance_seq),true),
        '{displayName}',to_jsonb(instance.display_name),true),
      '{note}',to_jsonb(instance.note),true),
    state_revision=CASE WHEN repair.id IS NULL THEN instance.state_revision ELSE instance.state_revision+1 END,
    updated_at=CASE WHEN repair.id IS NULL THEN instance.updated_at ELSE now() END
FROM (SELECT user_id,id FROM janus_employee_profile_repairs) repair
WHERE repair.user_id=instance.user_id AND repair.id=instance.id;

UPDATE cloud_employee_roster_states state
SET roster_revision=roster_revision+1,updated_at=now()
WHERE EXISTS (
  SELECT 1 FROM janus_employee_profile_repairs repair WHERE repair.user_id=state.user_id
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_user_agent_instances_unique_family_seq
  ON cloud_user_agent_instances_v3(user_id,agent_family_id,family_instance_seq)
  WHERE family_instance_seq>0;

DROP FUNCTION janus_agent_sequence_label(integer);
