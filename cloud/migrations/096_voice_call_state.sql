CREATE TABLE IF NOT EXISTS voice_call_sessions (
  id text PRIMARY KEY,
  account_workspace_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('direct','group')),
  group_id text NOT NULL DEFAULT '',
  caller_user_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ringing','active','ended','rejected','cancelled','missed','failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  ended_at timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  request_payload_hash text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voice_call_sessions_workspace_status
  ON voice_call_sessions(account_workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS voice_call_participants (
  call_id text NOT NULL REFERENCES voice_call_sessions(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('host','member')),
  status text NOT NULL CHECK (status IN ('invited','ringing','joined','left','rejected','kicked','failed')),
  invited_at timestamptz NOT NULL DEFAULT now(),
  joined_at timestamptz,
  left_at timestamptz,
  display_name_snapshot text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_voice_call_participants_user_status
  ON voice_call_participants(user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS voice_call_events (
  id text PRIMARY KEY,
  call_id text NOT NULL REFERENCES voice_call_sessions(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  event_type text NOT NULL,
  actor_user_id text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, sequence)
);
