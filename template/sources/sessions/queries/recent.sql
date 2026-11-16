SELECT id, title, status, cwd, host, kind, short_id, live, last_message, last_prompt, decision, updated, hidden
FROM sessions_items
WHERE hidden = :hidden
LIMIT :limit
