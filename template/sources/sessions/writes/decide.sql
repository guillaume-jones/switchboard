UPDATE sessions.items SET answer = json(:answer), updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE id = :id AND decision ->> '$.at' = :at AND status IN ('needs_permission', 'needs_input')
