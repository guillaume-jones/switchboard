INSERT OR REPLACE INTO sessions.seen (session, seen_at) VALUES (:session, CAST(unixepoch('subsec') * 1000 AS INTEGER))
