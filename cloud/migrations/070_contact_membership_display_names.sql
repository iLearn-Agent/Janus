CREATE TABLE IF NOT EXISTS social_contact_remarks (
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remark text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, target_user_id),
  CHECK (owner_user_id <> target_user_id)
);

ALTER TABLE contact_organization_members
  ADD COLUMN IF NOT EXISTS display_name_override text NOT NULL DEFAULT '';

ALTER TABLE chat_group_members
  ADD COLUMN IF NOT EXISTS display_name_override text NOT NULL DEFAULT '';

ALTER TABLE collaboration_group_members
  ADD COLUMN IF NOT EXISTS display_name_override text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_social_contact_remarks_target
  ON social_contact_remarks (target_user_id, updated_at DESC);
