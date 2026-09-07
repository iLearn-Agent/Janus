ALTER TABLE cloud_user_agent_instances_v3 DROP CONSTRAINT IF EXISTS chk_cloud_agent_instance_kind;
ALTER TABLE cloud_user_agent_instances_v3
  ADD CONSTRAINT chk_cloud_agent_instance_kind CHECK(instance_kind IN ('employee','system','system_service','governance','unavailable'));

INSERT INTO cloud_agent_families_v3(
  id,department_id,name,role,payload_json,status,routable,current_version_id,instance_kind,recruitable,default_for_new_user,quota_cost,updated_at
) VALUES(
  'follower_agent','','Follower','system_service',
  '{"runtimeSurface":"follower_service","evolutionSubjectKind":"system_service","hidden":true,"releaseTarget":"system_agent_follower"}'::jsonb,
  'active',false,'','system',false,false,0,now()
) ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS cloud_follower_report_projections (
  change_seq bigserial PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_workspace_id text NOT NULL DEFAULT 'workspace_personal',
  projection_id text NOT NULL,
  origin_device_id text NOT NULL DEFAULT '',
  report_kind text NOT NULL,
  window_start timestamptz,
  window_end timestamptz,
  timezone text NOT NULL DEFAULT '',
  projection_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_body text NOT NULL DEFAULT '',
  validated_hash text NOT NULL,
  privacy_validator_version text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,account_workspace_id,projection_id),
  CHECK(revision>=1)
);
CREATE INDEX IF NOT EXISTS idx_cloud_follower_projection_changes
  ON cloud_follower_report_projections(owner_user_id,account_workspace_id,change_seq);
CREATE TABLE IF NOT EXISTS cloud_follower_report_changes (
  change_seq bigserial PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_workspace_id text NOT NULL DEFAULT 'workspace_personal',
  projection_id text NOT NULL,
  operation text NOT NULL,
  projection_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(operation IN ('upsert','delete'))
);
CREATE INDEX IF NOT EXISTS idx_cloud_follower_report_change_cursor
  ON cloud_follower_report_changes(owner_user_id,account_workspace_id,change_seq);

CREATE TABLE IF NOT EXISTS cloud_follower_service_bindings (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_workspace_id text NOT NULL DEFAULT 'workspace_personal',
  service_instance_id text NOT NULL,
  subject_kind text NOT NULL DEFAULT 'system_service',
  status text NOT NULL DEFAULT 'active',
  state_revision bigint NOT NULL DEFAULT 1,
  personal_overlay_version_id text NOT NULL DEFAULT '',
  preference_memory_version_id text NOT NULL DEFAULT '',
  cluster_bundle_id text NOT NULL DEFAULT '',
  command_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id,account_workspace_id),
  UNIQUE(owner_user_id,service_instance_id),
  CHECK(subject_kind='system_service'),
  CHECK(status IN ('active','inactive')),
  CHECK(state_revision>=1)
);

CREATE TABLE IF NOT EXISTS cloud_follower_preference_signals (
  evidence_id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_workspace_id text NOT NULL DEFAULT 'workspace_personal',
  service_instance_id text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  source_version text NOT NULL DEFAULT '',
  signal_kind text NOT NULL,
  normalized_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  signal_hash text NOT NULL,
  lineage_key text NOT NULL,
  confidence real NOT NULL DEFAULT 1,
  personal_eligible boolean NOT NULL DEFAULT true,
  cluster_eligible boolean NOT NULL DEFAULT true,
  validation_state text NOT NULL DEFAULT 'validated',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,account_workspace_id,lineage_key,signal_hash),
  CHECK(confidence>=0 AND confidence<=1)
);
CREATE INDEX IF NOT EXISTS idx_cloud_follower_cluster_evidence
  ON cloud_follower_preference_signals(cluster_eligible,occurred_at,evidence_id);

CREATE TABLE IF NOT EXISTS cloud_follower_personal_versions (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_workspace_id text NOT NULL DEFAULT 'workspace_personal',
  service_instance_id text NOT NULL,
  version_kind text NOT NULL,
  version_no integer NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,account_workspace_id,version_kind,version_no),
  CHECK(version_kind IN ('personal_overlay','preference_memory')),
  CHECK(status IN ('candidate','active','archived','rejected')),
  CHECK(version_no>=1)
);

CREATE TABLE IF NOT EXISTS cloud_follower_cluster_candidates (
  id text PRIMARY KEY,
  cohort_key text NOT NULL DEFAULT 'family:follower_agent',
  threshold_profile text NOT NULL DEFAULT 'follower_service_cluster_v1',
  release_target text NOT NULL DEFAULT 'system_agent_follower',
  status text NOT NULL DEFAULT 'draft',
  evidence_count integer NOT NULL DEFAULT 0,
  user_count integer NOT NULL DEFAULT 0,
  support_instance_count integer NOT NULL DEFAULT 0,
  sections_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  support_proof_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  governance_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  shadow_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  canary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(release_target='system_agent_follower'),
  CHECK(status IN ('draft','gated','governance_approved','shadow_passed','canary_running','canary_passed','released','rejected'))
);

CREATE TABLE IF NOT EXISTS cloud_follower_canary_evaluations (
  id text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES cloud_follower_cluster_candidates(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_instance_id text NOT NULL,
  outcome text NOT NULL,
  metrics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(candidate_id,owner_user_id),
  CHECK(outcome IN ('passed','failed'))
);

CREATE TABLE IF NOT EXISTS cloud_follower_system_bundles (
  id text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES cloud_follower_cluster_candidates(id) ON DELETE RESTRICT,
  release_target text NOT NULL DEFAULT 'system_agent_follower',
  release_version text NOT NULL,
  bundle_json jsonb NOT NULL,
  content_hash text NOT NULL,
  signing_key_id text NOT NULL,
  status text NOT NULL DEFAULT 'released',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(candidate_id),
  CHECK(release_target='system_agent_follower'),
  CHECK(status IN ('released','suspended','rolled_back'))
);

-- requires-real-postgres-tail: follower-family-collision-validation
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cloud_agent_families_v3 WHERE id='follower_agent'
      AND NOT (
        role='system_service' AND routable=false AND recruitable=false AND default_for_new_user=false
        AND quota_cost=0 AND COALESCE(payload_json->>'runtimeSurface','')='follower_service'
        AND COALESCE(payload_json->>'evolutionSubjectKind','')='system_service'
      )
  ) THEN
    RAISE EXCEPTION 'follower_agent cloud family identity collision';
  END IF;
  UPDATE cloud_agent_families_v3 SET
    name='Follower',role='system_service',status='active',routable=false,instance_kind='system',recruitable=false,
    default_for_new_user=false,quota_cost=0,
    payload_json='{"runtimeSurface":"follower_service","evolutionSubjectKind":"system_service","hidden":true,"releaseTarget":"system_agent_follower"}'::jsonb,
    updated_at=now()
  WHERE id='follower_agent';
END $$;
