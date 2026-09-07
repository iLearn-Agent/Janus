-- A client with an installed, routable Agent may promote the shared cloud catalog.
-- Promotions are monotonic so another device without the optional Skill cannot downgrade it again.
-- requires-real-postgres: DISTINCT ON CTE update
WITH promotable AS (
  SELECT DISTINCT ON (entity_id)
    entity_id,
    payload_json
  FROM cloud_sync_entities_v6
  WHERE entity_type='agent_family'
    AND deleted=false
    AND lower(COALESCE(payload_json->>'instance_kind',payload_json->>'instanceKind',''))='employee'
    AND lower(COALESCE(payload_json->>'recruitable','false')) IN ('1','true')
    AND lower(COALESCE(payload_json->>'routable','false')) IN ('1','true')
  ORDER BY entity_id,updated_at DESC
)
UPDATE cloud_agent_families_v3 family
SET instance_kind='employee',
    recruitable=true,
    routable=true,
    current_version_id=COALESCE(NULLIF(promotable.payload_json->>'current_version_id',''),
      NULLIF(promotable.payload_json->>'currentVersionId',''),family.current_version_id),
    quota_cost=GREATEST(family.quota_cost,1),
    updated_at=now()
FROM promotable
WHERE family.id=promotable.entity_id
  AND family.role='agent'
  AND family.id<>'secretary_agent';
