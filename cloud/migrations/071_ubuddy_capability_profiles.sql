CREATE TABLE IF NOT EXISTS social_ubuddy_capability_profiles (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ubuddy_agent_instance_id text NOT NULL,
  profile_revision bigint NOT NULL,
  profile_version text NOT NULL DEFAULT 'ubuddy_capability_profile_v1',
  visibility text NOT NULL,
  publication_state text NOT NULL DEFAULT 'active',
  source_effective_skill_hash text NOT NULL,
  content_hash text NOT NULL,
  profile_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  state_revision bigint NOT NULL DEFAULT 1,
  last_command_id text NOT NULL DEFAULT '',
  published_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id,ubuddy_agent_instance_id,profile_revision),
  CHECK(profile_revision >= 1),
  CHECK(state_revision >= 1),
  CHECK(visibility IN ('friends','organization')),
  CHECK(publication_state IN ('active','archived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_ubuddy_profile_one_active
  ON social_ubuddy_capability_profiles(owner_user_id)
  WHERE publication_state='active';

CREATE INDEX IF NOT EXISTS idx_social_ubuddy_profile_updated
  ON social_ubuddy_capability_profiles(owner_user_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS social_ubuddy_capability_profile_commands (
  command_id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_kind text NOT NULL,
  payload_hash text NOT NULL,
  response_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(operation_kind IN ('publish','unpublish'))
);

CREATE INDEX IF NOT EXISTS idx_social_ubuddy_profile_commands_owner
  ON social_ubuddy_capability_profile_commands(owner_user_id,created_at DESC);
