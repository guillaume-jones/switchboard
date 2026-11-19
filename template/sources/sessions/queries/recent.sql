SELECT i.id, i.title, i.status, i.cwd, i.host, i.kind, i.short_id, i.live, i.last_message, i.last_prompt, i.decision, i.updated, i.hidden,
  i.id IN (SELECT session FROM sessions_notified) AS notified
FROM sessions_items i
WHERE i.hidden = :hidden
ORDER BY i.created DESC
LIMIT :limit
