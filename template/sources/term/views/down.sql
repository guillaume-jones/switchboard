SELECT coalesce((SELECT r.id FROM core_runs r WHERE r.rule = 'term-serve' ORDER BY r.created DESC LIMIT 1), 'none') AS last
WHERE NOT EXISTS (SELECT 1 FROM core_runs r WHERE r.rule = 'term-serve' AND r.state IN ('queued', 'running'))
