ALTER TABLE cloud_personal_version_health
  ADD COLUMN IF NOT EXISTS last_performance_input_hash text NOT NULL DEFAULT '';
