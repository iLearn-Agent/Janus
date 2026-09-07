-- Cloud Context Space, multi-Memory identity, and state-machine hardening.
-- requires-real-postgres: windowed historical deduplication and constraint validation

UPDATE cloud_memory_documents_v3 SET visibility='agent_private' WHERE visibility='private';
UPDATE cloud_agent_cohorts SET status='inactive' WHERE status='disabled';
UPDATE cloud_market_agent_candidates SET status='archived' WHERE status='disabled';
UPDATE cloud_market_agent_versions SET status='archived' WHERE status='disabled';
UPDATE cloud_user_market_adoptions SET status='ignored' WHERE status='disabled';
UPDATE cloud_personal_evolution_proposals_v4 SET status='legacy_proposal_stale' WHERE status IN ('running','proposed');
UPDATE cloud_evolution_runs SET trigger_kind='scheduled' WHERE trigger_kind IN ('auto','automatic');

CREATE TEMP TABLE _janus_memory_document_merges (
  user_id text NOT NULL,
  alias_id text NOT NULL,
  canonical_id text NOT NULL,
  user_agent_instance_id text NOT NULL,
  alias_cloud_key text NOT NULL
);
INSERT INTO _janus_memory_document_merges(user_id,alias_id,canonical_id,user_agent_instance_id,alias_cloud_key)
WITH ranked AS (
  SELECT d.*,
    FIRST_VALUE(id) OVER (
      PARTITION BY user_id,user_agent_instance_id,scope,slot_no,task_run_id,project_id,relationship_id
      ORDER BY created_at,id
    ) AS canonical_id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id,user_agent_instance_id,scope,slot_no,task_run_id,project_id,relationship_id
      ORDER BY created_at,id
    ) AS row_no
  FROM cloud_memory_documents_v3 d
)
SELECT user_id,id AS alias_id,canonical_id,user_agent_instance_id,
  COALESCE(NULLIF(cloud_key,''),NULLIF(payload_json->>'cloud_key',''),NULLIF(payload_json->>'cloudKey',''),id) AS alias_cloud_key
FROM ranked WHERE row_no > 1;

INSERT INTO cloud_memory_document_aliases_v3(user_id,alias_document_id,canonical_document_id,reason)
SELECT user_id,alias_id,canonical_id,'migration_slot_identity_conflict'
FROM _janus_memory_document_merges
ON CONFLICT(user_id,alias_document_id) DO UPDATE SET
  canonical_document_id=excluded.canonical_document_id,reason=excluded.reason;

WITH affected AS (
  SELECT v.user_id,v.id,
    ROW_NUMBER() OVER (
      PARTITION BY v.user_id,COALESCE(m.canonical_id,v.memory_document_id)
      ORDER BY v.created_at,v.id
    ) AS ordinal
  FROM cloud_memory_document_versions_v3 v
  LEFT JOIN _janus_memory_document_merges m
    ON m.user_id=v.user_id AND m.alias_id=v.memory_document_id
  WHERE m.alias_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM _janus_memory_document_merges x
    WHERE x.user_id=v.user_id AND x.canonical_id=v.memory_document_id
  )
)
UPDATE cloud_memory_document_versions_v3 v SET version_no=-affected.ordinal
FROM affected WHERE v.user_id=affected.user_id AND v.id=affected.id;

UPDATE cloud_memory_document_versions_v3 v SET memory_document_id=m.canonical_id
FROM _janus_memory_document_merges m
WHERE v.user_id=m.user_id AND v.memory_document_id=m.alias_id;

WITH affected AS (
  SELECT v.user_id,v.id,
    ROW_NUMBER() OVER (PARTITION BY v.user_id,v.memory_document_id ORDER BY v.created_at,v.id) AS ordinal
  FROM cloud_memory_document_versions_v3 v
  WHERE EXISTS (
    SELECT 1 FROM _janus_memory_document_merges m
    WHERE m.user_id=v.user_id AND m.canonical_id=v.memory_document_id
  )
)
UPDATE cloud_memory_document_versions_v3 v SET version_no=affected.ordinal
FROM affected WHERE v.user_id=affected.user_id AND v.id=affected.id;

UPDATE cloud_personal_evolution_memory_operations_v4 o SET memory_document_id=m.canonical_id
FROM _janus_memory_document_merges m
WHERE o.user_id=m.user_id AND o.memory_document_id=m.alias_id;

UPDATE cloud_work_memory_versions w SET memory_document_id=m.canonical_id
FROM _janus_memory_document_merges m
WHERE w.owner_user_id=m.user_id AND w.memory_document_id=m.alias_id;

UPDATE cloud_memory_access_audits a SET memory_document_id=m.canonical_id
FROM _janus_memory_document_merges m
WHERE a.owner_user_id=m.user_id AND a.memory_document_id=m.alias_id;

DELETE FROM cloud_memory_documents_v3 d
WHERE EXISTS (SELECT 1 FROM _janus_memory_document_merges m WHERE d.user_id=m.user_id AND d.id=m.alias_id);

WITH current_versions AS (
  SELECT d.user_id,d.id,v.id AS version_id,
    ROW_NUMBER() OVER (PARTITION BY d.user_id,d.id ORDER BY v.created_at DESC,v.version_no DESC,v.id DESC) AS row_no
  FROM cloud_memory_documents_v3 d
  LEFT JOIN cloud_memory_document_versions_v3 v
    ON v.user_id=d.user_id AND v.memory_document_id=d.id
  WHERE EXISTS (
    SELECT 1 FROM _janus_memory_document_merges m
    WHERE m.user_id=d.user_id AND m.canonical_id=d.id
  )
)
UPDATE cloud_memory_documents_v3 d SET current_version_id=COALESCE(c.version_id,'')
FROM current_versions c
WHERE c.row_no=1 AND d.user_id=c.user_id AND d.id=c.id;

CREATE UNIQUE INDEX idx_cloud_memory_documents_slot_identity_v3
  ON cloud_memory_documents_v3(
    user_id,user_agent_instance_id,scope,slot_no,task_run_id,project_id,relationship_id
  );

ALTER TABLE cloud_agent_context_spaces RENAME TO cloud_agent_context_spaces_legacy_v20;
ALTER TABLE cloud_memory_sync_mappings RENAME TO cloud_memory_sync_mappings_legacy_v20;

CREATE TABLE cloud_agent_context_spaces (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  user_agent_instance_id text NOT NULL,
  context_kind text NOT NULL,
  memory_document_id text,
  project_id text NOT NULL DEFAULT '',
  task_run_id text NOT NULL DEFAULT '',
  delegation_id text NOT NULL DEFAULT '',
  group_id text NOT NULL DEFAULT '',
  relationship_user_id text NOT NULL DEFAULT '',
  lifecycle_state text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,id),
  FOREIGN KEY(user_id,user_agent_instance_id)
    REFERENCES cloud_user_agent_instances_v3(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,memory_document_id)
    REFERENCES cloud_memory_documents_v3(user_id,id) ON DELETE CASCADE,
  CHECK(context_kind IN ('general_memory','project','task','relationship')),
  CHECK(lifecycle_state IN ('active','inactive','archived')),
  CHECK(
    (context_kind='general_memory' AND memory_document_id IS NOT NULL AND project_id='' AND task_run_id='' AND relationship_user_id='') OR
    (context_kind='project' AND memory_document_id IS NULL AND project_id<>'' AND task_run_id='' AND relationship_user_id='') OR
    (context_kind='task' AND memory_document_id IS NULL AND task_run_id<>'' AND project_id='' AND relationship_user_id='') OR
    (context_kind='relationship' AND memory_document_id IS NULL AND relationship_user_id<>'' AND project_id='' AND task_run_id='')
  )
);

CREATE UNIQUE INDEX idx_cloud_agent_context_spaces_identity
  ON cloud_agent_context_spaces(
    user_id,user_agent_instance_id,context_kind,COALESCE(memory_document_id,''),project_id,
    task_run_id,delegation_id,group_id,relationship_user_id
  );
CREATE INDEX idx_cloud_agent_context_spaces_instance
  ON cloud_agent_context_spaces(user_id,user_agent_instance_id,lifecycle_state,updated_at);

INSERT INTO cloud_agent_context_spaces(
  user_id,id,user_agent_instance_id,context_kind,memory_document_id,lifecycle_state,created_at,updated_at
)
SELECT user_id,
  COALESCE((SELECT MIN(c.id) FROM cloud_agent_context_spaces_legacy_v20 c
    WHERE c.user_id=cloud_memory_documents_v3.user_id AND c.user_agent_instance_id=cloud_memory_documents_v3.user_agent_instance_id
      AND c.context_kind='general_memory' AND c.memory_document_id=cloud_memory_documents_v3.id),
    NULLIF(context_space_id,''),'ctx_'||md5(concat_ws('|',user_id,user_agent_instance_id,'general_memory',id))),
  user_agent_instance_id,'general_memory',id,lifecycle_state,created_at,updated_at
FROM cloud_memory_documents_v3 WHERE scope='general'
ON CONFLICT DO NOTHING;

INSERT INTO cloud_agent_context_spaces(
  user_id,id,user_agent_instance_id,context_kind,project_id,lifecycle_state,created_at,updated_at
)
SELECT user_id,
  COALESCE((SELECT MIN(c.id) FROM cloud_agent_context_spaces_legacy_v20 c
    WHERE c.user_id=cloud_memory_documents_v3.user_id AND c.user_agent_instance_id=cloud_memory_documents_v3.user_agent_instance_id
      AND c.context_kind='project' AND c.project_id=cloud_memory_documents_v3.project_id),
    MIN(NULLIF(context_space_id,'')),'ctx_'||md5(concat_ws('|',user_id,user_agent_instance_id,'project',project_id))),
  user_agent_instance_id,'project',project_id,
  CASE WHEN bool_or(lifecycle_state='active') THEN 'active' ELSE 'inactive' END,
  MIN(created_at),MAX(updated_at)
FROM cloud_memory_documents_v3 WHERE scope='project' AND project_id<>''
GROUP BY user_id,user_agent_instance_id,project_id
ON CONFLICT DO NOTHING;

INSERT INTO cloud_agent_context_spaces(
  user_id,id,user_agent_instance_id,context_kind,task_run_id,delegation_id,group_id,lifecycle_state,created_at,updated_at
)
SELECT user_id,
  COALESCE((SELECT MIN(c.id) FROM cloud_agent_context_spaces_legacy_v20 c
    WHERE c.user_id=cloud_memory_documents_v3.user_id AND c.user_agent_instance_id=cloud_memory_documents_v3.user_agent_instance_id
      AND c.context_kind='task' AND c.task_run_id=cloud_memory_documents_v3.task_run_id),
    MIN(NULLIF(context_space_id,'')),'ctx_'||md5(concat_ws('|',user_id,user_agent_instance_id,'task',task_run_id,delegation_id,group_id))),
  user_agent_instance_id,'task',task_run_id,
  delegation_id,group_id,
  CASE WHEN bool_or(lifecycle_state='active') THEN 'active' ELSE 'inactive' END,
  MIN(created_at),MAX(updated_at)
FROM cloud_memory_documents_v3 WHERE scope='task' AND task_run_id<>''
GROUP BY user_id,user_agent_instance_id,task_run_id,delegation_id,group_id
ON CONFLICT DO NOTHING;

INSERT INTO cloud_agent_context_spaces(
  user_id,id,user_agent_instance_id,context_kind,relationship_user_id,lifecycle_state,created_at,updated_at
)
SELECT user_id,
  COALESCE((SELECT MIN(c.id) FROM cloud_agent_context_spaces_legacy_v20 c
    WHERE c.user_id=cloud_memory_documents_v3.user_id AND c.user_agent_instance_id=cloud_memory_documents_v3.user_agent_instance_id
      AND c.context_kind='relationship' AND c.relationship_user_id=cloud_memory_documents_v3.relationship_id),
    MIN(NULLIF(context_space_id,'')),'ctx_'||md5(concat_ws('|',user_id,user_agent_instance_id,'relationship',relationship_id))),
  user_agent_instance_id,'relationship',relationship_id,
  CASE WHEN bool_or(lifecycle_state='active') THEN 'active' ELSE 'inactive' END,
  MIN(created_at),MAX(updated_at)
FROM cloud_memory_documents_v3 WHERE scope='relationship' AND relationship_id<>''
GROUP BY user_id,user_agent_instance_id,relationship_id
ON CONFLICT DO NOTHING;

UPDATE cloud_memory_documents_v3 d SET context_space_id=c.id
FROM cloud_agent_context_spaces c
WHERE c.user_id=d.user_id AND c.user_agent_instance_id=d.user_agent_instance_id AND (
  (d.scope='general' AND c.context_kind='general_memory' AND c.memory_document_id=d.id) OR
  (d.scope='project' AND c.context_kind='project' AND c.project_id=d.project_id) OR
  (d.scope='task' AND c.context_kind='task' AND c.task_run_id=d.task_run_id) OR
  (d.scope='relationship' AND c.context_kind='relationship' AND c.relationship_user_id=d.relationship_id)
);

CREATE TABLE cloud_memory_sync_mappings (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent_instance_id text NOT NULL,
  cloud_key text NOT NULL,
  memory_document_id text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id,user_agent_instance_id,cloud_key),
  FOREIGN KEY(owner_user_id,user_agent_instance_id)
    REFERENCES cloud_user_agent_instances_v3(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_user_id,memory_document_id)
    REFERENCES cloud_memory_documents_v3(user_id,id) ON DELETE CASCADE,
  CHECK(status IN ('active','superseded','revoked'))
);
CREATE UNIQUE INDEX idx_cloud_memory_sync_mapping_active_document
  ON cloud_memory_sync_mappings(owner_user_id,memory_document_id) WHERE status='active';
CREATE INDEX idx_cloud_memory_sync_mapping_document
  ON cloud_memory_sync_mappings(owner_user_id,memory_document_id,status,updated_at);

INSERT INTO cloud_memory_sync_mappings(
  owner_user_id,user_agent_instance_id,cloud_key,memory_document_id,status,created_at,updated_at
)
SELECT user_id,user_agent_instance_id,
  COALESCE(NULLIF(cloud_key,''),NULLIF(payload_json->>'cloud_key',''),NULLIF(payload_json->>'cloudKey',''),id),
  id,'active',created_at,updated_at
FROM cloud_memory_documents_v3
ON CONFLICT DO NOTHING;

INSERT INTO cloud_memory_sync_mappings(
  owner_user_id,user_agent_instance_id,cloud_key,memory_document_id,status,created_at,updated_at
)
SELECT l.owner_user_id,d.user_agent_instance_id,l.cloud_key,d.id,
  CASE WHEN l.status='revoked' THEN 'revoked' ELSE 'superseded' END,
  l.created_at,l.updated_at
FROM cloud_memory_sync_mappings_legacy_v20 l
LEFT JOIN cloud_memory_document_aliases_v3 a
  ON a.user_id=l.owner_user_id AND a.alias_document_id=l.memory_document_id
JOIN cloud_memory_documents_v3 d
  ON d.user_id=l.owner_user_id AND d.id=COALESCE(a.canonical_document_id,l.memory_document_id)
WHERE l.cloud_key<>COALESCE(NULLIF(d.cloud_key,''),NULLIF(d.payload_json->>'cloud_key',''),NULLIF(d.payload_json->>'cloudKey',''),d.id)
ON CONFLICT DO NOTHING;

INSERT INTO cloud_memory_sync_mappings(
  owner_user_id,user_agent_instance_id,cloud_key,memory_document_id,status
)
SELECT m.user_id,m.user_agent_instance_id,m.alias_cloud_key,m.canonical_id,'superseded'
FROM _janus_memory_document_merges m
WHERE m.alias_cloud_key<>(SELECT cloud_key FROM cloud_memory_sync_mappings x
  WHERE x.owner_user_id=m.user_id AND x.memory_document_id=m.canonical_id AND x.status='active' LIMIT 1)
ON CONFLICT DO NOTHING;

ALTER TABLE cloud_memory_documents_v3
  ADD CONSTRAINT chk_cloud_memory_scope CHECK(scope IN ('general','task','project','relationship')),
  ADD CONSTRAINT chk_cloud_memory_lifecycle CHECK(lifecycle_state IN ('active','inactive','archived')),
  ADD CONSTRAINT chk_cloud_memory_visibility CHECK(visibility IN ('agent_private','owner_private','work_collaborators','work_leadership','work_participants','work_summary')),
  ADD CONSTRAINT chk_cloud_memory_slot CHECK(slot_no>=0),
  ADD CONSTRAINT fk_cloud_memory_instance FOREIGN KEY(user_id,user_agent_instance_id)
    REFERENCES cloud_user_agent_instances_v3(user_id,id) ON DELETE CASCADE;

ALTER TABLE cloud_memory_document_versions_v3
  ADD CONSTRAINT chk_cloud_memory_version_no CHECK(version_no>=1),
  ADD CONSTRAINT fk_cloud_memory_version_document FOREIGN KEY(user_id,memory_document_id)
    REFERENCES cloud_memory_documents_v3(user_id,id) ON DELETE CASCADE;

ALTER TABLE cloud_evolution_evidence_usage
  ADD CONSTRAINT chk_cloud_evidence_scope CHECK(evolution_scope IN ('personal','cluster')),
  ADD CONSTRAINT chk_cloud_evidence_usage_status CHECK(status IN ('available','reserved','consumed','evaluated_rejected','released'));

ALTER TABLE cloud_evolution_runs
  ADD CONSTRAINT chk_cloud_evolution_run_scope CHECK(evolution_scope IN ('personal','cluster')),
  ADD CONSTRAINT chk_cloud_evolution_run_trigger CHECK(trigger_kind IN ('manual','scheduled')),
  ADD CONSTRAINT chk_cloud_evolution_run_status CHECK(status IN ('queued','claimed','running','proposed','applied','failed_retryable','failed_terminal','evaluated_rejected','rolled_back','skipped','insufficient_evidence')),
  ADD CONSTRAINT chk_cloud_evolution_run_count CHECK(evidence_count>=0),
  ADD CONSTRAINT chk_cloud_evolution_run_identity CHECK(
    (evolution_scope='personal' AND owner_user_id<>'' AND user_agent_instance_id<>'' AND cohort_id='' AND consumer_id=user_agent_instance_id) OR
    (evolution_scope='cluster' AND cohort_id<>'' AND user_agent_instance_id='' AND consumer_id=cohort_id)
  );

ALTER TABLE cloud_evolution_jobs
  ADD CONSTRAINT chk_cloud_evolution_job_kind CHECK(job_kind IN ('personal_evolution','cluster_evolution')),
  ADD CONSTRAINT chk_cloud_evolution_job_status CHECK(status IN ('queued','claimed','running','completed','failed_retryable','failed_terminal','cancelled')),
  ADD CONSTRAINT chk_cloud_evolution_job_attempts CHECK(attempt_count>=0 AND max_attempts>=1);

ALTER TABLE cloud_user_agent_instances_v3
  ADD CONSTRAINT chk_cloud_agent_instance_status CHECK(status IN ('active','inactive')),
  ADD CONSTRAINT chk_cloud_agent_instance_kind CHECK(instance_kind IN ('employee','system','governance','unavailable')),
  ADD CONSTRAINT chk_cloud_agent_employment_state CHECK(employment_state IN ('active','inactive')),
  ADD CONSTRAINT chk_cloud_agent_state_consistency CHECK(status=employment_state),
  ADD CONSTRAINT chk_cloud_agent_state_revision CHECK(state_revision>=1);

ALTER TABLE cloud_agent_performance_levels
  ADD CONSTRAINT chk_cloud_performance_level CHECK(level IN ('P1','P2','P3','P4','P5','P6','P7','P8','P9','P10')),
  ADD CONSTRAINT chk_cloud_performance_score CHECK(score>=0 AND score<=100 AND completed_task_count>=0);
ALTER TABLE cloud_agent_performance_history
  ADD CONSTRAINT chk_cloud_performance_history_level CHECK(level IN ('P1','P2','P3','P4','P5','P6','P7','P8','P9','P10')),
  ADD CONSTRAINT chk_cloud_performance_history_score CHECK(score>=0 AND score<=100);
ALTER TABLE cloud_agent_cohort_members
  ADD CONSTRAINT chk_cloud_cohort_member_level CHECK(performance_level IN ('P1','P2','P3','P4','P5','P6','P7','P8','P9','P10'));

ALTER TABLE cloud_personal_evolution_schedule_states
  ADD CONSTRAINT chk_cloud_personal_schedule_status CHECK(last_status IN ('never_evaluated','insufficient_evidence','queued','applied','evaluated_rejected','failed_retryable','failed_terminal','legacy_proposal_stale')),
  ADD CONSTRAINT chk_cloud_personal_schedule_count CHECK(last_evidence_count>=0);

ALTER TABLE cloud_personal_evolution_proposals_v4
  ADD CONSTRAINT chk_cloud_personal_proposal_status CHECK(status IN ('ready','partially_applied','applied','rejected','legacy_proposal_stale'));
ALTER TABLE cloud_personal_evolution_memory_operations_v4
  ADD CONSTRAINT chk_cloud_memory_operation_status CHECK(status IN ('pending','applied','rejected'));
ALTER TABLE cloud_personal_skill_overlay_versions
  ADD CONSTRAINT chk_cloud_overlay_status CHECK(status IN ('candidate','active','archived','rejected')),
  ADD CONSTRAINT chk_cloud_overlay_stability CHECK(stability_status IN ('candidate','stable')),
  ADD CONSTRAINT chk_cloud_overlay_authority CHECK(authority='cloud');
ALTER TABLE cloud_personal_version_health
  ADD CONSTRAINT chk_cloud_version_health_status CHECK(status IN ('collecting','healthy','regressing','rollback_required','rolled_back')),
  ADD CONSTRAINT chk_cloud_version_health_values CHECK(observed_task_count>=0 AND consecutive_regression_windows>=0);
ALTER TABLE cloud_agent_cohorts
  ADD CONSTRAINT chk_cloud_cohort_status CHECK(status IN ('active','ineligible','inactive'));
ALTER TABLE cloud_market_agent_candidates
  ADD CONSTRAINT chk_cloud_market_candidate_status CHECK(status IN ('draft','released','rejected','archived'));
ALTER TABLE cloud_market_agent_versions
  ADD CONSTRAINT chk_cloud_market_version_status CHECK(status IN ('draft','released','rejected','archived'));
ALTER TABLE cloud_user_market_adoptions
  ADD CONSTRAINT chk_cloud_market_adoption_status CHECK(status IN ('adopted','superseded','rolled_back','ignored'));

DROP TABLE _janus_memory_document_merges;
DROP TABLE cloud_agent_context_spaces_legacy_v20;
DROP TABLE cloud_memory_sync_mappings_legacy_v20;
