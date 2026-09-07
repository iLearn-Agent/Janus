CREATE TABLE IF NOT EXISTS cloud_personal_evolution_schedule_states (
  user_agent_instance_id text PRIMARY KEY,
  last_evaluated_at timestamptz,
  next_eligible_at timestamptz NOT NULL DEFAULT now(),
  last_status text NOT NULL DEFAULT 'never_evaluated',
  last_evidence_count integer NOT NULL DEFAULT 0,
  last_run_id text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_personal_evolution_schedule_due
  ON cloud_personal_evolution_schedule_states(next_eligible_at, user_agent_instance_id);

DROP INDEX IF EXISTS idx_cloud_evolution_active_personal_run;
CREATE UNIQUE INDEX idx_cloud_evolution_active_personal_run
  ON cloud_evolution_runs(user_agent_instance_id)
  WHERE evolution_scope = 'personal'
    AND status IN ('queued','claimed','running','proposed','failed_retryable');
