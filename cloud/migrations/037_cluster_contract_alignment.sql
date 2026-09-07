ALTER TABLE cloud_agent_cohorts
  ADD COLUMN IF NOT EXISTS minimum_user_count integer NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS maximum_user_weight_share double precision NOT NULL DEFAULT 0.15,
  ADD COLUMN IF NOT EXISTS participation_policy_version text NOT NULL DEFAULT 'cluster_active_synced_mandatory_v1';

UPDATE cloud_agent_cohorts SET
  minimum_user_count=7,
  maximum_user_weight_share=0.15,
  participation_policy_version='cluster_active_synced_mandatory_v1';

-- requires-real-postgres-tail: named CHECK constraints are installed only by real PostgreSQL.
ALTER TABLE cloud_agent_cohorts DROP CONSTRAINT IF EXISTS chk_cloud_cluster_contract_alignment;
ALTER TABLE cloud_agent_cohorts ADD CONSTRAINT chk_cloud_cluster_contract_alignment CHECK(
  minimum_user_count=7 AND
  maximum_user_weight_share=0.15 AND
  participation_policy_version='cluster_active_synced_mandatory_v1'
);
