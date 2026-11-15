INSERT OR REPLACE INTO sessions.hidden (session, hidden_at) VALUES (:id, CAST(unixepoch('subsec') * 1000 AS INTEGER))
