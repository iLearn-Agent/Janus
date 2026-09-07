-- Expand the favorite identity so Unicode favorites use their value digest.
CREATE UNIQUE INDEX IF NOT EXISTS idx_emoji_favorites_owner_kind_digest_value
  ON emoji_favorites(user_id,kind,sha256,value);
