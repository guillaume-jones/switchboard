DELETE FROM core.events WHERE at < :before;
DELETE FROM core.runs WHERE coalesce(finished_at, created_at) < :before AND state NOT IN ('queued', 'running', 'open');
DELETE FROM core.firings
WHERE (key LIKE 'slot:%' OR key LIKE 'file:%' OR key LIKE 'system:%') AND at < :occurrences_before;
