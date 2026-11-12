INSERT INTO workstreams.streams (id, title, last_activity)
VALUES (:id, :title, CAST(unixepoch('subsec') * 1000 AS INTEGER))
ON CONFLICT (id) DO UPDATE SET title = excluded.title
