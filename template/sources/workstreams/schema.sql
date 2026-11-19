CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  list TEXT NOT NULL DEFAULT 'default',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due TEXT, -- YYYY-MM-DD
  tags TEXT NOT NULL DEFAULT '[]', -- JSON array of names in `tags`
  position REAL NOT NULL, -- manual order within the list; moves pick a value between the new neighbours
  done_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  folder TEXT -- projects: where new chats start, as typed (~/ or a name under ~/Documents)
);
CREATE INDEX items_list ON items (list, position);

CREATE TABLE tags (
  name TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL
);

-- What an item ties together: a ref (`sessions:<id>`, `workstreams:<id>`) or a URL.
CREATE TABLE links (
  item INTEGER NOT NULL,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL, -- session | project | url
  label TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item, ref)
);
CREATE INDEX links_ref ON links (ref);

