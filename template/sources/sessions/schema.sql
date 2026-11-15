CREATE TABLE items (
  id TEXT PRIMARY KEY NOT NULL,
  agent TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  cwd TEXT,
  run_id TEXT,
  raw TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  host TEXT,
  entrypoint TEXT,
  last_message TEXT,
  last_prompt TEXT,
  decision TEXT,
  answer TEXT
);
CREATE INDEX items_run ON items (run_id);
CREATE INDEX items_updated ON items (updated_at);

CREATE TABLE transcripts (
  session TEXT PRIMARY KEY NOT NULL,
  opened_at INTEGER NOT NULL
);

CREATE TABLE messages (
  uuid TEXT PRIMARY KEY NOT NULL,
  session TEXT NOT NULL,
  at TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX messages_session ON messages (session, at);

CREATE TABLE hidden (
  session TEXT PRIMARY KEY NOT NULL,
  hidden_at INTEGER NOT NULL
);
