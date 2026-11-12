UPDATE attention.items SET cleared_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE ref = :ref AND cleared_at IS NULL
