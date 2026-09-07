UPDATE cloud_agent_families_v3
SET status='retired',routable=false,instance_kind='unavailable',recruitable=false,
    default_for_new_user=false,quota_cost=0,updated_at=now()
WHERE id IN ('general_agent_1','general_agent_2','general_agent_3');

-- requires-real-postgres-tail: migrate legacy instances and rewrite linked family projections
WITH canonical_max AS (
  SELECT user_id,COALESCE(MAX(CASE WHEN COALESCE(payload_json->>'familyInstanceSeq','')=''
    THEN 0 ELSE (payload_json->>'familyInstanceSeq')::integer END),0) AS max_sequence
  FROM cloud_user_agent_instances_v3
  WHERE agent_family_id='general_agent'
  GROUP BY user_id
), legacy AS (
  SELECT instance.user_id,instance.id,instance.payload_json,
    COALESCE(canonical_max.max_sequence,0)+COUNT(preceding.id) AS next_sequence
  FROM cloud_user_agent_instances_v3 instance
  LEFT JOIN canonical_max ON canonical_max.user_id=instance.user_id
  LEFT JOIN cloud_user_agent_instances_v3 preceding
    ON preceding.user_id=instance.user_id
    AND preceding.agent_family_id IN ('general_agent_1','general_agent_2','general_agent_3')
    AND (
      preceding.created_at < instance.created_at
      OR (preceding.created_at=instance.created_at AND preceding.id <= instance.id)
    )
  WHERE instance.agent_family_id IN ('general_agent_1','general_agent_2','general_agent_3')
  GROUP BY instance.user_id,instance.id,instance.payload_json,canonical_max.max_sequence
), canonical_family AS (
  SELECT current_version_id FROM cloud_agent_families_v3 WHERE id='general_agent'
)
UPDATE cloud_user_agent_instances_v3 instance
SET agent_family_id='general_agent',
    base_agent_version_id=CASE WHEN COALESCE((SELECT current_version_id FROM canonical_family),'')=''
      THEN instance.base_agent_version_id ELSE (SELECT current_version_id FROM canonical_family) END,
    payload_json=jsonb_set(
      jsonb_set(instance.payload_json,'{familyInstanceSeq}',to_jsonb(legacy.next_sequence),true),
      '{displayName}',
      to_jsonb(CASE
        WHEN COALESCE(instance.payload_json->>'displayName','')=''
          OR COALESCE(instance.payload_json->>'displayName','') ~ '^通用 Agent [123]( [A-Z]+)?$'
          THEN '通用 Agent ' || CASE WHEN legacy.next_sequence <= 26
            THEN chr(64 + legacy.next_sequence::integer) ELSE legacy.next_sequence::text END
        ELSE instance.payload_json->>'displayName'
      END),
      true
    ),
    updated_at=now()
FROM legacy
WHERE instance.user_id=legacy.user_id AND instance.id=legacy.id;

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
          AND identity_column.column_name='user_agent_instance_id'
      )
      AND columns.table_name NOT IN ('cloud_agent_families_v3','cloud_agent_versions_v3')
  LOOP
    EXECUTE format(
      'UPDATE %I SET agent_family_id=''general_agent'' WHERE agent_family_id IN (''general_agent_1'',''general_agent_2'',''general_agent_3'')',
      target.table_name
    );
  END LOOP;
END $$;
