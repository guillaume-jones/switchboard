SELECT s.run_id, s.id AS session
FROM sessions.items s JOIN core_runs r ON r.id = s.run_id
WHERE s.status = 'ended' AND r.state = 'open'
