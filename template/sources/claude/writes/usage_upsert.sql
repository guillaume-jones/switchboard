INSERT INTO claude.usage (id, raw, fetched_at)
VALUES (1, :payload, CAST(unixepoch('subsec') * 1000 AS INTEGER))
ON CONFLICT (id) DO UPDATE SET raw = excluded.raw, fetched_at = excluded.fetched_at
