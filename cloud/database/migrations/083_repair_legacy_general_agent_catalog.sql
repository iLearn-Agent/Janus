-- requires-real-postgres: legacy Generalist identity repair uses PL/pgSQL, window functions, and dynamic reference rebinding.
CREATE OR REPLACE FUNCTION janus_general_catalog_sequence_label(input_value integer)
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

CREATE TEMP TABLE janus_legacy_general_instance_repairs(
  user_id text NOT NULL,
  id text NOT NULL,
  target_sequence integer NOT NULL,
  target_display_name text NOT NULL,
  PRIMARY KEY(user_id,id)
) ON COMMIT DROP;

WITH canonical_max AS (
  SELECT user_id,COALESCE(MAX(family_instance_seq),0)::integer AS maximum
  FROM cloud_user_agent_instances_v3
  WHERE agent_family_id='general_agent'
  GROUP BY user_id
), legacy AS (
  SELECT instance.*,
    COALESCE(canonical_max.maximum,0)+row_number() OVER (
      PARTITION BY instance.user_id
      ORDER BY instance.recruited_at,instance.created_at,instance.id
    )::integer AS target_sequence
  FROM cloud_user_agent_instances_v3 instance
  LEFT JOIN canonical_max ON canonical_max.user_id=instance.user_id
  WHERE instance.agent_family_id ~ '^general_agent_[1-9][0-9]*$'
)
INSERT INTO janus_legacy_general_instance_repairs(user_id,id,target_sequence,target_display_name)
SELECT user_id,id,target_sequence,
  CASE WHEN display_name=''
    OR display_name='Generalist ' || janus_general_catalog_sequence_label(GREATEST(family_instance_seq,1))
    OR display_name='General Agent ' || janus_general_catalog_sequence_label(GREATEST(family_instance_seq,1))
    OR display_name='通用 Agent ' || janus_general_catalog_sequence_label(GREATEST(family_instance_seq,1))
    OR display_name ~ ('^(General Agent|通用 Agent) [1-9][0-9]* '
      || janus_general_catalog_sequence_label(GREATEST(family_instance_seq,1)) || '$')
    THEN 'Generalist ' || janus_general_catalog_sequence_label(target_sequence)
    ELSE display_name END
FROM legacy;

WITH canonical_family AS (
  SELECT current_version_id FROM cloud_agent_families_v3 WHERE id='general_agent'
)
UPDATE cloud_user_agent_instances_v3 instance
SET agent_family_id='general_agent',
  base_agent_version_id=CASE WHEN COALESCE((SELECT current_version_id FROM canonical_family),'')=''
    THEN instance.base_agent_version_id ELSE (SELECT current_version_id FROM canonical_family) END,
  family_instance_seq=repair.target_sequence,
  display_name=repair.target_display_name,
  payload_json=jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(COALESCE(instance.payload_json,'{}'::jsonb),'{agent_family_id}',to_jsonb('general_agent'::text),true),
        '{agentFamilyId}',to_jsonb('general_agent'::text),true),
      '{familyInstanceSeq}',to_jsonb(repair.target_sequence),true),
    '{displayName}',to_jsonb(repair.target_display_name),true),
  state_revision=instance.state_revision+1,
  updated_at=now()
FROM janus_legacy_general_instance_repairs repair
WHERE instance.user_id=repair.user_id AND instance.id=repair.id;

-- The production Evidence table uses FORCE ROW LEVEL SECURITY. The dedicated
-- migrator owns Community baseline tables but intentionally has no BYPASSRLS;
-- suspend FORCE only inside this migration transaction and restore it before
-- commit so the dynamic reference rebind can preserve existing Evidence rows.
ALTER TABLE cloud_evolution_evidence NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE target record;
BEGIN
  FOR target IN
    SELECT columns.table_name
    FROM information_schema.columns columns
    WHERE columns.table_schema='public' AND columns.column_name='agent_family_id'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns identity_column
        WHERE identity_column.table_schema=columns.table_schema
          AND identity_column.table_name=columns.table_name
          AND identity_column.column_name IN ('user_agent_instance_id','agent_instance_id')
      )
      AND columns.table_name NOT IN ('cloud_agent_families_v3','cloud_agent_versions_v3','cloud_user_agent_instances_v3')
  LOOP
    EXECUTE format(
      'UPDATE %I SET agent_family_id=''general_agent'' WHERE agent_family_id ~ ''^general_agent_[1-9][0-9]*$''',
      target.table_name
    );
  END LOOP;
END $$;

ALTER TABLE cloud_evolution_evidence FORCE ROW LEVEL SECURITY;

UPDATE cloud_agent_families_v3
SET name='Generalist',status='retired',routable=false,instance_kind='unavailable',recruitable=false,
  default_for_new_user=false,quota_cost=0,
  payload_json=jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(COALESCE(payload_json,'{}'::jsonb),'{name}',to_jsonb('Generalist'::text),true),
        '{status}',to_jsonb('retired'::text),true),
      '{instanceKind}',to_jsonb('unavailable'::text),true),
    '{recruitable}','false'::jsonb,true),
  updated_at=now()
WHERE id ~ '^general_agent_[1-9][0-9]*$'
  AND (name<>'Generalist' OR status<>'retired' OR routable OR instance_kind<>'unavailable'
    OR recruitable OR default_for_new_user OR quota_cost<>0);

UPDATE cloud_employee_roster_states state
SET roster_revision=roster_revision+1,updated_at=now()
WHERE EXISTS (
  SELECT 1 FROM janus_legacy_general_instance_repairs repair WHERE repair.user_id=state.user_id
);

DROP FUNCTION janus_general_catalog_sequence_label(integer);
