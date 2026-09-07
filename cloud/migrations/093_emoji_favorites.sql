CREATE TABLE IF NOT EXISTS emoji_favorites (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'image',
  value text NOT NULL DEFAULT '',
  filename text NOT NULL DEFAULT '',
  content_type text NOT NULL DEFAULT '',
  size_bytes bigint NOT NULL DEFAULT 0,
  sha256 text NOT NULL DEFAULT '',
  data bytea,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,kind,sha256),
  CHECK(kind IN ('unicode','image')),
  CHECK(size_bytes >= 0 AND size_bytes <= 2097152),
  CHECK((kind='unicode' AND value<>'') OR (kind='image' AND data IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_emoji_favorites_user_order ON emoji_favorites(user_id,sort_order,created_at);
