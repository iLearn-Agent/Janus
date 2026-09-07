ALTER TABLE cloud_task_security_contexts_v5
  ADD COLUMN IF NOT EXISTS cloud_collaboration_allowed boolean NOT NULL DEFAULT false;
