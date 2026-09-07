ALTER TABLE friendships ADD COLUMN IF NOT EXISTS user_a_remark text NOT NULL DEFAULT '';
ALTER TABLE friendships ADD COLUMN IF NOT EXISTS user_b_remark text NOT NULL DEFAULT '';
