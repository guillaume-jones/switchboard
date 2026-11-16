UPDATE sessions.queue SET interject = max(interject, :interject), error = NULL, queued_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE session = :session
