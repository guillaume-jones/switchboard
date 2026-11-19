UPDATE sessions.items SET status = 'ready', decision = NULL, answer = NULL
WHERE id = :id AND decision ->> '$.at' = :at
