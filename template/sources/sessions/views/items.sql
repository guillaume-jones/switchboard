SELECT s.id, s.agent, coalesce(s.title, s.cwd, s.id) AS title, s.status, s.cwd, s.run_id, s.host, s.entrypoint,
  s.host = 'switchboard' AS owned, s.last_message, s.last_prompt, s.decision, s.answer, r.state AS run_state, r.command AS run_command,
  datetime(s.updated_at / 1000, 'unixepoch', 'localtime') AS updated
FROM sessions.items s LEFT JOIN core_runs r ON r.id = s.run_id
ORDER BY s.updated_at DESC
