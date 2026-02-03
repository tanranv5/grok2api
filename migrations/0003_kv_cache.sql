-- KV cache metadata (for /images proxy)

DROP TABLE IF EXISTS r2_cache;

CREATE TABLE IF NOT EXISTS kv_cache (
  key TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('image', 'video')),
  size INTEGER NOT NULL,
  content_type TEXT,
  created_at INTEGER NOT NULL,
  last_access_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_kv_cache_type_access ON kv_cache(type, last_access_at);

