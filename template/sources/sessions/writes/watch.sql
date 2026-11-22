INSERT OR REPLACE INTO sessions.watches (session, armed_at) VALUES (:session, CAST(unixepoch('subsec') * 1000 AS INTEGER))
