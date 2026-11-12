UPDATE sessions.items SET status = :status, updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE id = :id AND :status IN ('working', 'needs_input', 'waiting', 'ended')
