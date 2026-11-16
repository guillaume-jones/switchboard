SELECT DISTINCT coalesce(r.args ->> '$.session', i.id) AS session, r.id AS run_id, r.args ->> '$.cwd' AS cwd
FROM core_runs AS r
LEFT JOIN sessions.items AS i ON r.args ->> '$.session' IS NULL AND i.run_id = r.id AND i.host = 'switchboard'
WHERE r.command = 'sessions.serve' AND r.state IN ('queued', 'running') AND coalesce(r.args ->> '$.session', i.id) IS NOT NULL
