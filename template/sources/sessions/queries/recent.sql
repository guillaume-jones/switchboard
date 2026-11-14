SELECT id, title, status, cwd, run_id, host, owned, last_message, decision, run_state, run_command, updated
FROM sessions_items
LIMIT :limit
