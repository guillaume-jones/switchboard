CREATE TABLE streams (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  last_activity INTEGER
);

CREATE TABLE members (
  stream_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  component TEXT,
  props TEXT,
  added_by TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (stream_id, ref)
);
