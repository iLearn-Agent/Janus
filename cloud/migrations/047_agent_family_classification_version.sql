ALTER TABLE cloud_agent_families_v3
  ADD COLUMN IF NOT EXISTS classification_version text NOT NULL DEFAULT 'employee_recruitment_phase_a_v1';
