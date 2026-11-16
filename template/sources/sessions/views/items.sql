SELECT ids.id, coalesce(s.agent, 'claude') AS agent,
  coalesce(iif(a.kind = 'background', a.name, NULL), s.title, a.name, s.cwd, a.cwd, ids.id) AS title,
  CASE
    WHEN s.status IN ('needs_permission', 'needs_input') AND s.decision IS NOT NULL AND s.answer IS NULL
      AND coalesce(a.live, 1) THEN s.status
    WHEN a.session IS NULL THEN s.status
    WHEN a.kind = 'interactive' AND NOT a.live THEN 'ended'
    WHEN a.state IN ('working', 'busy') THEN 'working'
    WHEN a.state = 'blocked' THEN iif(a.live, 'needs_input', 'stopped')
    WHEN a.state IN ('done', 'idle') THEN 'ready'
    ELSE coalesce(a.state, s.status)
  END AS status,
  coalesce(s.cwd, a.cwd) AS cwd, iif(a.kind = 'background', 'background', s.host) AS host, s.entrypoint,
  a.kind, a.short_id, coalesce(a.live, 0) AS live,
  s.last_message, s.last_prompt, s.decision, s.answer,
  datetime(max(coalesce(s.updated_at, 0), coalesce(a.changed_at, 0), coalesce(a.started_at, 0)) / 1000, 'unixepoch', 'localtime') AS updated,
  ids.id IN (SELECT session FROM sessions.hidden) AS hidden
FROM (SELECT id FROM sessions.items UNION SELECT session FROM sessions.agents) AS ids
LEFT JOIN sessions.items s ON s.id = ids.id
LEFT JOIN sessions.agents a ON a.session = ids.id
ORDER BY updated DESC
