INSERT INTO sessions.items (id, agent, title, status, cwd, run_id, raw, created_at, updated_at)
VALUES (
  :payload ->> '$.session_id',
  'claude',
  substr(:payload ->> '$.prompt', 1, 200),
  CASE :payload ->> '$.hook_event_name'
    WHEN 'SessionEnd' THEN 'ended'
    WHEN 'Notification' THEN 'needs_input'
    WHEN 'Stop' THEN 'waiting'
    WHEN 'SessionStart' THEN 'waiting'
    ELSE 'working'
  END,
  :payload ->> '$.cwd',
  :run_id,
  :payload,
  CAST(unixepoch('subsec') * 1000 AS INTEGER),
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
)
ON CONFLICT (id) DO UPDATE SET
  title = coalesce(title, excluded.title),
  status = excluded.status,
  cwd = excluded.cwd,
  run_id = coalesce(run_id, excluded.run_id),
  raw = excluded.raw,
  updated_at = excluded.updated_at
