CREATE TABLE prs (
  url TEXT PRIMARY KEY NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT,
  state TEXT NOT NULL,
  draft INTEGER,
  review_decision TEXT,
  merge_state TEXT,
  ci TEXT,
  new_comments INTEGER,
  folder TEXT,
  created_at INTEGER,
  closed_at INTEGER,
  raw TEXT,
  fetched_at INTEGER NOT NULL
);
