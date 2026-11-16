DELETE FROM sessions.titles WHERE session = :id AND trim(:title) = '';
INSERT INTO sessions.titles (session, title, renamed_at)
SELECT :id, trim(:title), CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE trim(:title) <> ''
ON CONFLICT (session) DO UPDATE SET title = excluded.title, renamed_at = excluded.renamed_at
