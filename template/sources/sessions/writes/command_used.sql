INSERT INTO sessions.command_uses (name, used_at) VALUES (:name, CAST(unixepoch('subsec') * 1000 AS INTEGER))
ON CONFLICT (name) DO UPDATE SET used_at = excluded.used_at
