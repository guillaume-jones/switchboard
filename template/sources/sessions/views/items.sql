SELECT id, agent, coalesce(title, cwd, id) AS title, status, cwd, run_id,
  datetime(updated_at / 1000, 'unixepoch', 'localtime') AS updated
FROM sessions.items
ORDER BY updated_at DESC
