CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  list TEXT NOT NULL DEFAULT 'default', -- to-dos: default (Now) | later | blocked; projects: projects
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due TEXT, -- YYYY-MM-DD
  position REAL NOT NULL, -- manual order within the list; moves pick a value between the new neighbours
  done_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  folder TEXT, -- projects: where new chats start, as typed (~/ or a name under ~/Documents)
  notes_file TEXT -- projects: absolute or ~/ path of a Markdown file shown instead of description
);
CREATE INDEX items_list ON items (list, position);

-- What an item ties together: a ref (`sessions:<id>`, `workstreams:<id>`) or a URL.
CREATE TABLE links (
  item INTEGER NOT NULL,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL, -- session | pr | project | url
  label TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item, ref)
);
CREATE INDEX links_ref ON links (ref);
