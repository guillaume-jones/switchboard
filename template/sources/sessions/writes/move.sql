INSERT OR REPLACE INTO sessions.folders (session, cwd, moved_at) VALUES (:id, :cwd, CAST(unixepoch('subsec') * 1000 AS INTEGER))
