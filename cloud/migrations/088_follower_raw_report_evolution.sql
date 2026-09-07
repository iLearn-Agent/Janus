CREATE TABLE IF NOT EXISTS cloud_follower_raw_reports (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_workspace_id text NOT NULL DEFAULT 'workspace_personal',
  report_id text NOT NULL,
  origin_device_id text NOT NULL DEFAULT '',
  report_kind text NOT NULL,
  report_json jsonb NOT NULL,
  rendered_body text NOT NULL,
  validated_hash text NOT NULL,
  privacy_validator_version text NOT NULL DEFAULT '',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(owner_user_id,account_workspace_id,report_id),
  CHECK(report_kind IN ('daily_brief','weekly_review','growth_guidance'))
);
CREATE INDEX IF NOT EXISTS idx_cloud_follower_raw_reports_evolution
  ON cloud_follower_raw_reports(report_kind,updated_at) WHERE deleted_at IS NULL;
