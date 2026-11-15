SELECT id, title, status, cwd, run_id, host, owned, last_message, last_prompt, decision, run_state, run_command, updated
FROM sessions_items
WHERE (id IN (SELECT session FROM sessions.hidden)) = :hidden
LIMIT :limit
