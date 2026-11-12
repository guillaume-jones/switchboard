UPDATE core.runs SET state = 'unknown', summary = coalesce(summary, :summary), finished_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE id = :id AND state IN ('running', 'open')
