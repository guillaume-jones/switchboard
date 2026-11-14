UPDATE sessions.items SET status = 'ready', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE id = :line ->> '$.sessionId'
  AND :line ->> '$.type' = 'user'
  AND :line ->> '$.message.content[0].text' LIKE '[Request interrupted by user%'
  AND status IN ('working', 'needs_permission', 'needs_input')
