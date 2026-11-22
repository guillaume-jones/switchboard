-- Markdown files as last read by docs.read, for previews.
CREATE TABLE files (
  path TEXT PRIMARY KEY, -- as given, e.g. ~/notes/plan.md
  text TEXT,
  error TEXT,
  read_at INTEGER NOT NULL
);
