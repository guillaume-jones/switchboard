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
  answer TEXT,
  origin TEXT
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
  tokens INTEGER,
  model TEXT,
  tool_id TEXT,
  tool_name TEXT,
  is_error INTEGER
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

-- Slash commands Claude reported for a folder in its last init event (sessions.serve).
CREATE TABLE commands (
  cwd TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (cwd, name)
);

CREATE TABLE command_uses (
  name TEXT PRIMARY KEY NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE INDEX command_uses_used ON command_uses (used_at);

-- When the user last viewed each session's transcript: a session updated since is unread.
CREATE TABLE seen (
  session TEXT PRIMARY KEY NOT NULL,
  seen_at INTEGER NOT NULL
);

-- Sessions the user asked to be notified about once their current turn ends, or after every turn when sticky.
CREATE TABLE watches (
  session TEXT PRIMARY KEY NOT NULL,
  armed_at INTEGER NOT NULL,
  sticky INTEGER NOT NULL DEFAULT 0
);

-- The model picked for a session, which it resumes on from its next message or open on.
CREATE TABLE models (
  session TEXT PRIMARY KEY NOT NULL,
  model TEXT NOT NULL,
  set_at INTEGER NOT NULL
);

-- Subagents of transcribed sessions, from Claude Code's subagents/agent-<id>.jsonl lines and .meta.json.
CREATE TABLE subagents (
  id TEXT PRIMARY KEY NOT NULL,
  session TEXT NOT NULL,
  description TEXT,
  agent_type TEXT,
  background INTEGER,
  activity TEXT,
  started_at TEXT,
  updated_at TEXT,
  done INTEGER
);
CREATE INDEX subagents_session ON subagents (session);

-- A user message being edited from Switchboard: it and later messages are hidden, and its session's next send resumes Claude just before it (sessions.serve rewind) and deletes them.
CREATE TABLE rewinds (
  session TEXT PRIMARY KEY NOT NULL,
  uuid TEXT NOT NULL,
  at TEXT NOT NULL
);

-- @deprecated sessions.transcript loads only the active branch instead
CREATE TABLE dropped (
  uuid TEXT PRIMARY KEY NOT NULL,
  session TEXT NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX dropped_session ON dropped (session);

-- @deprecated streaming partial messages was dropped
CREATE TABLE streams (
  session TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  label TEXT,
  text TEXT NOT NULL,
  started_at TEXT NOT NULL
);
