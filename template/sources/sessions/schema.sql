CREATE TABLE items (
  id TEXT PRIMARY KEY NOT NULL,
  agent TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  cwd TEXT,
  run_id TEXT,
  raw TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX items_run ON items (run_id);
