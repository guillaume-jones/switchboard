-- Archived sessions are listed again while they need the user: live and asking for a permission or input. Sessions of automations
-- start archived (sessions.claude_hook).
SELECT id, agent, title, status, cwd, host, entrypoint, kind, short_id, live, last_message, last_prompt, decision, answer, created,
  updated, origin, unread, model,
  archived AND NOT coalesce(live AND status IN ('needs_permission', 'needs_input'), 0) AS hidden
FROM (
SELECT ids.id, coalesce(s.agent, 'claude') AS agent,
  coalesce(t.title, iif(a.kind = 'background', a.name, NULL), s.title, a.name, s.cwd, a.cwd, ids.id) AS title,
  CASE
    WHEN s.status IN ('needs_permission', 'needs_input') AND s.decision IS NOT NULL AND s.answer IS NULL
      AND (sv.run_id IS NOT NULL OR (s.host IS NOT 'switchboard' AND coalesce(a.live, 1))) THEN s.status
    WHEN sv.run_id IS NOT NULL THEN iif(coalesce(s.status, 'ended') = 'ended', 'ready', s.status)
    WHEN s.host = 'switchboard' THEN iif(s.status = 'errored', 'errored', 'ready')
    WHEN a.session IS NULL THEN s.status
    WHEN NOT a.live AND a.kind = 'background' THEN iif(a.state = 'blocked', 'stopped', iif(s.status = 'errored', 'errored', 'ready'))
    WHEN NOT a.live OR s.status = 'ended' THEN 'ended'
    WHEN s.status IS NOT NULL THEN s.status
    WHEN a.state IN ('working', 'busy') THEN 'working'
    WHEN a.state = 'blocked' THEN 'needs_input'
    WHEN a.state IN ('done', 'idle') THEN 'ready'
    ELSE a.state
  END AS status,
  coalesce(f.cwd, s.cwd, a.cwd) AS cwd, iif(a.kind = 'background', 'background', s.host) AS host, s.entrypoint,
  CASE
    WHEN sv.run_id IS NOT NULL OR s.host = 'switchboard' OR a.kind = 'background' THEN 'background'
    ELSE a.kind
  END AS kind,
  substr(ids.id, 1, 8) AS short_id,
  CASE
    WHEN sv.run_id IS NOT NULL THEN 1
    WHEN s.host = 'switchboard' THEN 0
    ELSE coalesce(a.live, 0) AND s.status IS NOT 'ended'
  END AS live,
  s.last_message, s.last_prompt, s.decision, s.answer,
  coalesce(min(s.created_at, a.started_at), s.created_at, a.started_at) AS created,
  datetime(max(coalesce(s.updated_at, 0), coalesce(a.changed_at, 0), coalesce(a.started_at, 0)) / 1000, 'unixepoch', 'localtime') AS updated,
  ids.id IN (SELECT session FROM sessions.hidden) AS archived,
  s.origin, coalesce(s.updated_at > seen.seen_at, 1) AS unread, m.model
FROM (SELECT id FROM sessions.items UNION SELECT session FROM sessions.agents) AS ids
LEFT JOIN sessions.items s ON s.id = ids.id
LEFT JOIN sessions.agents a ON a.session = ids.id
LEFT JOIN sessions.titles t ON t.session = ids.id
LEFT JOIN sessions.folders f ON f.session = ids.id
LEFT JOIN sessions_served sv ON sv.session = ids.id
LEFT JOIN sessions.seen seen ON seen.session = ids.id
LEFT JOIN sessions.models m ON m.session = ids.id
)
ORDER BY updated DESC
