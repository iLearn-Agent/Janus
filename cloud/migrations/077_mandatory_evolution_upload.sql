ALTER TABLE cloud_user_evolution_preferences
  ALTER COLUMN enabled SET DEFAULT true;

ALTER TABLE cloud_user_evolution_preferences
  ALTER COLUMN policy_version SET DEFAULT 'evolution_mandatory_upload_v1';

UPDATE cloud_user_evolution_preferences SET
  enabled=true,
  policy_version='evolution_mandatory_upload_v1',
  paused_at=NULL,
  state_revision=state_revision+1,
  updated_at=now()
WHERE enabled=false OR policy_version<>'evolution_mandatory_upload_v1' OR paused_at IS NOT NULL;

UPDATE cloud_user_agent_instances_v3 SET
  personal_evolution_consent=(sync_enabled AND status='active'),
  cluster_contribution_consent=(sync_enabled AND status='active'),
  personal_skill_auto_activate=false;

-- requires-real-postgres-tail: pg-mem cannot execute the PostgreSQL UPDATE ... FROM backfill or trigger DDL below.
UPDATE cloud_memory_documents_v3 d SET
  allow_personal_evolution=(i.sync_enabled AND i.status='active' AND d.lifecycle_state='active'),
  allow_cluster_evolution=(i.sync_enabled AND i.status='active' AND d.lifecycle_state='active')
FROM cloud_user_agent_instances_v3 i
WHERE i.user_id=d.user_id AND i.id=d.user_agent_instance_id;

ALTER TABLE cloud_user_evolution_preferences
  DROP CONSTRAINT IF EXISTS chk_cloud_evolution_preference_mandatory;
ALTER TABLE cloud_user_evolution_preferences
  ADD CONSTRAINT chk_cloud_evolution_preference_mandatory CHECK(enabled=true);

CREATE OR REPLACE FUNCTION janus_set_cluster_participation_authority()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.personal_evolution_consent=(NEW.sync_enabled AND NEW.status='active');
  NEW.cluster_contribution_consent=(NEW.sync_enabled AND NEW.status='active');
  NEW.personal_skill_auto_activate=false;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_cloud_cluster_participation_authority ON cloud_user_agent_instances_v3;
CREATE TRIGGER trg_cloud_cluster_participation_authority
BEFORE INSERT OR UPDATE OF sync_enabled,status,personal_evolution_consent,cluster_contribution_consent,personal_skill_auto_activate
ON cloud_user_agent_instances_v3
FOR EACH ROW EXECUTE FUNCTION janus_set_cluster_participation_authority();
