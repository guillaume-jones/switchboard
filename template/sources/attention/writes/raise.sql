INSERT INTO attention.items (ref, title, reason, level, created_at)
VALUES (:ref, nullif(:title, ''), :reason, :level, CAST(unixepoch('subsec') * 1000 AS INTEGER))
ON CONFLICT (ref) WHERE cleared_at IS NULL DO UPDATE SET title = excluded.title, reason = excluded.reason, level = excluded.level
