-- R2 cache metadata (for /images proxy)

CREATE TABLE IF NOT EXISTS r2_cache (
  key TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('image', 'video')),
  size INTEGER NOT NULL,
  etag TEXT,
  content_type TEXT,
  created_at INTEGER NOT NULL,
  last_access_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_r2_cache_type_access ON r2_cache(type, last_access_at);

