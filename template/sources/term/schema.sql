-- tmux sessions as last listed; tmux itself is the source of truth.
CREATE TABLE sessions (
  name TEXT PRIMARY KEY,
  cwd TEXT,
  chat TEXT, -- the sessions_items id it was opened from, if any
  attached INTEGER NOT NULL,
  created INTEGER NOT NULL
);
