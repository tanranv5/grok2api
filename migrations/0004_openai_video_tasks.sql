CREATE TABLE IF NOT EXISTS openai_video_tasks (
  id TEXT PRIMARY KEY,
  requested_model TEXT NOT NULL,
  internal_model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'in_progress', 'completed', 'failed')),
  asset_url TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_openai_video_tasks_status_updated
ON openai_video_tasks(status, updated_at);
