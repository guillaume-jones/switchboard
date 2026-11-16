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
