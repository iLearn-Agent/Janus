-- Canonicalize the retired multi-Agent PPT identities into the single `ppt`
-- employee without changing the winning instance id. Historical rows keep
-- their original ids; aliases make every retired instance resolve to the
-- canonical winner.
-- requires-real-postgres: correlated canonicalization is validated against PostgreSQL.
UPDATE cloud_user_agent_instances_v3 AS instance
SET agent_family_id='ppt',
    base_agent_version_id=COALESCE(NULLIF((SELECT current_version_id FROM cloud_agent_families_v3 WHERE id='ppt'),''),instance.base_agent_version_id),
    status=CASE WHEN EXISTS (
      SELECT 1 FROM cloud_user_agent_instances_v3 sibling
      WHERE sibling.user_id=instance.user_id
        AND sibling.agent_family_id IN ('ppt_academic_report','ppt_major_project','ppt_research_scout')
        AND sibling.employment_state='active'
    ) THEN 'active' ELSE 'inactive' END,
    instance_kind='employee',
    employment_state=CASE WHEN EXISTS (
      SELECT 1 FROM cloud_user_agent_instances_v3 sibling
      WHERE sibling.user_id=instance.user_id
        AND sibling.agent_family_id IN ('ppt_academic_report','ppt_major_project','ppt_research_scout')
        AND sibling.employment_state='active'
    ) THEN 'active' ELSE 'inactive' END,
    quota_exempt=false,
    deactivated_at=CASE WHEN EXISTS (
      SELECT 1 FROM cloud_user_agent_instances_v3 sibling
      WHERE sibling.user_id=instance.user_id
        AND sibling.agent_family_id IN ('ppt_academic_report','ppt_major_project','ppt_research_scout')
        AND sibling.employment_state='active'
    ) THEN NULL ELSE instance.deactivated_at END,
    last_state_changed_at=now(),
    state_revision=instance.state_revision+1,
    recruitment_source='ppt_identity_migration',
    policy_version='employee_cloud_authority_v1',
    sync_enabled=true,
    updated_at=now()
WHERE instance.agent_family_id IN ('ppt_academic_report','ppt_major_project','ppt_research_scout')
  AND NOT EXISTS (
    SELECT 1 FROM cloud_user_agent_instances_v3 canonical
    WHERE canonical.user_id=instance.user_id AND canonical.agent_family_id='ppt'
  )
  AND instance.id=(
    SELECT candidate.id
    FROM cloud_user_agent_instances_v3 candidate
    WHERE candidate.user_id=instance.user_id
      AND candidate.agent_family_id IN ('ppt_academic_report','ppt_major_project','ppt_research_scout')
    ORDER BY CASE WHEN candidate.employment_state='active' THEN 0 ELSE 1 END,
      candidate.created_at,candidate.id
    LIMIT 1
  );

-- If a canonical instance already existed, an active legacy instance means
-- the user's final effective PPT state is active.
UPDATE cloud_user_agent_instances_v3 AS canonical
SET status='active',employment_state='active',instance_kind='employee',quota_exempt=false,
    deactivated_at=NULL,last_state_changed_at=now(),state_revision=canonical.state_revision+1,
    base_agent_version_id=COALESCE(NULLIF((SELECT current_version_id FROM cloud_agent_families_v3 WHERE id='ppt'),''),canonical.base_agent_version_id),
    recruitment_source=CASE WHEN canonical.recruitment_source='' THEN 'ppt_identity_migration' ELSE canonical.recruitment_source END,
    policy_version='employee_cloud_authority_v1',sync_enabled=true,updated_at=now()
WHERE canonical.agent_family_id='ppt'
  AND canonical.recruitment_source<>'ppt_identity_migration'
  AND EXISTS (
    SELECT 1 FROM cloud_user_agent_instances_v3 legacy
    WHERE legacy.user_id=canonical.user_id
      AND legacy.agent_family_id IN ('ppt_academic_report','ppt_major_project','ppt_research_scout')
      AND legacy.employment_state='active'
  );

INSERT INTO cloud_user_agent_instance_aliases_v3(user_id,alias_instance_id,canonical_instance_id,reason)
SELECT legacy.user_id,legacy.id,canonical.id,'ppt_identity_migration'
FROM cloud_user_agent_instances_v3 legacy
JOIN cloud_user_agent_instances_v3 canonical
  ON canonical.user_id=legacy.user_id AND canonical.agent_family_id='ppt'
WHERE legacy.agent_family_id IN ('ppt_academic_report','ppt_major_project','ppt_research_scout')
ON CONFLICT(user_id,alias_instance_id) DO UPDATE SET
  canonical_instance_id=excluded.canonical_instance_id,reason=excluded.reason;

UPDATE cloud_user_agent_instances_v3 legacy
SET status='inactive',instance_kind='unavailable',employment_state='inactive',quota_exempt=true,
    deactivated_at=COALESCE(legacy.deactivated_at,now()),last_state_changed_at=now(),
    state_revision=legacy.state_revision+1,sync_enabled=false,
    personal_evolution_consent=false,cluster_contribution_consent=false,
    personal_skill_auto_activate=false,updated_at=now()
WHERE legacy.agent_family_id IN ('ppt_academic_report','ppt_major_project','ppt_research_scout')
  AND EXISTS (
    SELECT 1 FROM cloud_user_agent_instance_aliases_v3 alias
    WHERE alias.user_id=legacy.user_id AND alias.alias_instance_id=legacy.id
  );

INSERT INTO cloud_user_agent_recruitment_events(
  id,user_id,user_agent_instance_id,agent_family_id,event_type,previous_state,next_state,
  quota_before,quota_after,command_id,source_device_id,reason,metadata_json
)
SELECT 'ppt_identity_migration_'||canonical.user_id,canonical.user_id,canonical.id,'ppt',
  'identity_migrated','legacy_ppt',canonical.employment_state,0,0,
  'migration:ppt-canonical:'||canonical.user_id,canonical.source_device_id,
  'legacy_ppt_family_canonicalized',
  '{"canonicalAgentFamilyId":"ppt","preservedInstanceId":true}'::jsonb
FROM cloud_user_agent_instances_v3 canonical
WHERE canonical.agent_family_id='ppt'
  AND (
    canonical.recruitment_source='ppt_identity_migration'
    OR EXISTS (
      SELECT 1 FROM cloud_user_agent_instance_aliases_v3 alias
      WHERE alias.user_id=canonical.user_id AND alias.canonical_instance_id=canonical.id
        AND alias.reason='ppt_identity_migration'
    )
  )
ON CONFLICT(user_id,command_id) DO NOTHING;

UPDATE cloud_employee_roster_states roster
SET roster_revision=roster.roster_revision+1,updated_at=now()
WHERE EXISTS (
  SELECT 1 FROM cloud_user_agent_instances_v3 canonical
  WHERE canonical.user_id=roster.user_id AND canonical.agent_family_id='ppt'
    AND (
      canonical.recruitment_source='ppt_identity_migration'
      OR EXISTS (
        SELECT 1 FROM cloud_user_agent_instance_aliases_v3 alias
        WHERE alias.user_id=canonical.user_id AND alias.canonical_instance_id=canonical.id
          AND alias.reason='ppt_identity_migration'
      )
    )
);

UPDATE cloud_agent_families_v3
SET status='retired',routable=false,instance_kind='unavailable',recruitable=false,
    default_for_new_user=false,quota_cost=0,updated_at=now()
WHERE id IN ('ppt_academic_report','ppt_major_project','ppt_research_scout');
