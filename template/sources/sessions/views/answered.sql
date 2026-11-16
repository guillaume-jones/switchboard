SELECT id, decision ->> '$.at' AS at FROM sessions.items WHERE decision IS NOT NULL AND answer IS NOT NULL
