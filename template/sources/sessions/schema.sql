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
  text TEXT NOT NULL,
  tokens INTEGER
);
CREATE INDEX messages_session ON messages (session, at);

CREATE TABLE hidden (
  session TEXT PRIMARY KEY NOT NULL,
  hidden_at INTEGER NOT NULL
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Claude Code's own view of its sessions (`claude agents --json --all`): background sessions and interactive ones still open.
CREATE TABLE agents (
  session TEXT PRIMARY KEY NOT NULL,
  short_id TEXT,
  kind TEXT NOT NULL,
  state TEXT,
  name TEXT,
  cwd TEXT,
  live INTEGER NOT NULL,
  started_at INTEGER,
  changed_at INTEGER NOT NULL
);

-- Follow-ups waiting to be sent by the sessions-flush rule, one merged message per session.
CREATE TABLE queue (
  session TEXT PRIMARY KEY NOT NULL,
  text TEXT NOT NULL,
  files TEXT NOT NULL,
  interject INTEGER NOT NULL,
  queued_at INTEGER NOT NULL,
  error TEXT
);

-- The follow-up sessions.flush took from the queue, kept until its turn ends so the next one waits for it.
CREATE TABLE sending (
  session TEXT PRIMARY KEY NOT NULL,
  text TEXT NOT NULL,
  files TEXT NOT NULL,
  interject INTEGER NOT NULL,
  run_id TEXT,
  started_at INTEGER NOT NULL,
  sent_at INTEGER,
  acked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE drafts (
  key TEXT PRIMARY KEY NOT NULL,
  text TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Titles set by hand, overriding the derived one.
CREATE TABLE titles (
  session TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  renamed_at INTEGER NOT NULL
);

-- Folders chosen by hand: the next resume (sessions.send, sessions.open) runs there. Cleared once a hook reports the session in it.
CREATE TABLE folders (
  session TEXT PRIMARY KEY NOT NULL,
  cwd TEXT NOT NULL,
  moved_at INTEGER NOT NULL
);
