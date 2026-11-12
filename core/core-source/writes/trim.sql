DELETE FROM core.events WHERE at < :before;
DELETE FROM core.runs WHERE coalesce(finished_at, created_at) < :before AND state NOT IN ('queued', 'running', 'open');
DELETE FROM core.firings WHERE key LIKE 'slot:%' AND at < :slots_before;
