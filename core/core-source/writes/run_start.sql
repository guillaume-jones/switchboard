UPDATE core.runs SET state = 'running', pid = :pid, started_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE id = :id AND state = 'queued'
