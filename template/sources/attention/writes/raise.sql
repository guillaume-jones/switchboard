INSERT INTO attention.items (ref, reason, level, created_at)
VALUES (:ref, :reason, :level, CAST(unixepoch('subsec') * 1000 AS INTEGER))
ON CONFLICT (ref) WHERE cleared_at IS NULL DO UPDATE SET reason = excluded.reason, level = excluded.level
