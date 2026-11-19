CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  component TEXT NOT NULL,
  props TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL
);

-- The board each kind of client shows: `desktop` or `mobile`.
CREATE TABLE current (
  client TEXT PRIMARY KEY,
  board TEXT
);

CREATE TABLE tiles (
  grid TEXT NOT NULL,
  id TEXT NOT NULL,
  component TEXT NOT NULL,
  props TEXT NOT NULL DEFAULT '{}',
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  w INTEGER NOT NULL,
  h INTEGER NOT NULL,
  list_h INTEGER, -- rows in the phone list layout; NULL sizes the tile by its content
  PRIMARY KEY (grid, id)
);

-- Visited places per client, newest at the highest seq: a board (`session` NULL) or that client's chat board showing `session` ('' for a new chat).
CREATE TABLE history (
  client TEXT NOT NULL,
  seq INTEGER NOT NULL,
  board TEXT NOT NULL,
  session TEXT,
  PRIMARY KEY (client, seq)
);

-- The history entry each client is on; back and forward move it.
CREATE TABLE cursor (
  client TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);
