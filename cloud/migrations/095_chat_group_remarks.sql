ALTER TABLE chat_group_members
  ADD COLUMN IF NOT EXISTS remark text NOT NULL DEFAULT '';
