INSERT OR REPLACE INTO sessions.models (session, model, set_at) VALUES (:session, :model, CAST(unixepoch('subsec') * 1000 AS INTEGER))
