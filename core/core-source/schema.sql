CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  args TEXT,
  state TEXT NOT NULL,
  parent TEXT,
  pid INTEGER,
  summary TEXT,
  git_commit TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  depth INTEGER NOT NULL DEFAULT 0,
  rule TEXT
);
CREATE INDEX runs_state ON runs (state);
CREATE INDEX runs_created ON runs (created_at);

CREATE TABLE firings (
  id INTEGER PRIMARY KEY,
  rule TEXT NOT NULL,
  key TEXT NOT NULL,
  run_id TEXT,
  at INTEGER NOT NULL,
  blocked TEXT,
  git_commit TEXT,
  UNIQUE (rule, key)
);
CREATE INDEX firings_rule_at ON firings (rule, at);
CREATE INDEX firings_at ON firings (at);
CREATE INDEX firings_blocked ON firings (id) WHERE blocked IS NOT NULL;

CREATE TABLE rules (
  rule TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  disabled_reason TEXT,
  last_evaluated INTEGER
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  trigger TEXT,
  run_id TEXT,
  message TEXT,
  git_commit TEXT
);
CREATE INDEX events_at ON events (at);
CREATE INDEX events_kind ON events (kind, id);
CREATE INDEX events_run ON events (run_id);
CREATE INDEX events_name ON events (name, id);
