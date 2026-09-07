CREATE TABLE IF NOT EXISTS social_realtime_events (
  sequence_id bigserial PRIMARY KEY,
  id text NOT NULL UNIQUE,
  account_workspace_id text NOT NULL DEFAULT 'workspace_personal',
  recipient_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  aggregate_type text NOT NULL DEFAULT 'agent_delegation',
  aggregate_id text NOT NULL,
  aggregate_version bigint NOT NULL DEFAULT 0,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_social_realtime_events_recipient_sequence
  ON social_realtime_events(recipient_user_id, sequence_id);

CREATE INDEX IF NOT EXISTS idx_social_realtime_events_workspace_recipient_sequence
  ON social_realtime_events(account_workspace_id, recipient_user_id, sequence_id);

CREATE TABLE IF NOT EXISTS agent_delegation_execution_leases (
  delegation_id text PRIMARY KEY REFERENCES agent_delegations(id) ON DELETE CASCADE,
  account_workspace_id text NOT NULL DEFAULT 'workspace_personal',
  recipient_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  lease_token text NOT NULL UNIQUE,
  execution_epoch bigint NOT NULL DEFAULT 1,
  lease_expires_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  renewed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  release_reason text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_delegation_execution_leases_recipient_expiry
  ON agent_delegation_execution_leases(recipient_user_id, lease_expires_at);
