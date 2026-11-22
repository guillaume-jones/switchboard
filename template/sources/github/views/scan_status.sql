SELECT
  EXISTS (SELECT 1 FROM core_runs WHERE command = 'github.scan' AND state IN ('queued', 'running')) AS running,
  (SELECT max(finished_at) FROM core_runs WHERE command = 'github.scan' AND state = 'success') AS last_scan,
  (SELECT state FROM core_runs WHERE command = 'github.scan' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1) AS last_state,
  (SELECT summary FROM core_runs WHERE command = 'github.scan' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1) AS last_summary
