CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL,
  reason TEXT,
  title TEXT,
  level INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  cleared_at INTEGER,
  snooze_until INTEGER,
  woken_at INTEGER
);
CREATE UNIQUE INDEX items_open ON items (ref) WHERE cleared_at IS NULL;

-- Core error events up to and including `through` (a `core_events` id) are hidden from Health.
CREATE TABLE errors_cleared (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  through INTEGER NOT NULL
);
