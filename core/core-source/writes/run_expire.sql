UPDATE core.runs SET state = 'unknown', summary = coalesce(summary, 'expired while open'), finished_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE state = 'open' AND started_at < :before
