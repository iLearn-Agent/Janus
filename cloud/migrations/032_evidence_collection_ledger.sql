ALTER TABLE cloud_evolution_evidence
  ADD COLUMN IF NOT EXISTS personal_threshold_eligible boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS eligibility_policy_version text NOT NULL DEFAULT 'personal_threshold_v1';

UPDATE cloud_evolution_evidence
SET personal_threshold_eligible = source_kind IN (
  'message','conversation_segment','collaboration_message','memory_version','task_shared_summary',
  'task_result','task_acceptance','task_rework','task_failure','task_blocked','task_cancelled',
  'task_node_result','task_retrospective','model_execution','model_execution_metric'
), eligibility_policy_version='personal_threshold_v1';

CREATE INDEX IF NOT EXISTS idx_cloud_evidence_personal_threshold
  ON cloud_evolution_evidence(owner_user_id,user_agent_instance_id,personal_threshold_eligible,occurred_at,evidence_id)
  WHERE quarantine_reason='';
