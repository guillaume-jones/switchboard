INSERT INTO sessions.items (id, agent, title, status, cwd, run_id, raw, created_at, updated_at)
VALUES (
  :payload ->> '$.session_id',
  'claude',
  substr(:payload ->> '$.prompt', 1, 200),
  'ready',
  :payload ->> '$.cwd',
  :run_id,
  :payload,
  CAST(unixepoch('subsec') * 1000 AS INTEGER),
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
)
ON CONFLICT (id) DO UPDATE SET
  title = coalesce(title, excluded.title),
  cwd = excluded.cwd,
  run_id = coalesce(run_id, excluded.run_id),
  raw = excluded.raw,
  updated_at = excluded.updated_at;

UPDATE sessions.items SET status = new.status
FROM (
  SELECT CASE :payload ->> '$.hook_event_name'
    WHEN 'SessionStart' THEN iif(:payload ->> '$.source' = 'compact', NULL, 'ready')
    WHEN 'UserPromptSubmit' THEN 'working'
    WHEN 'PreToolUse' THEN iif(:payload ->> '$.tool_name' IN ('AskUserQuestion', 'ExitPlanMode'), 'needs_input', 'working')
    WHEN 'PermissionRequest' THEN 'needs_permission'
    WHEN 'PostToolUse' THEN 'working'
    WHEN 'PostToolUseFailure' THEN 'working'
    WHEN 'Notification' THEN CASE :payload ->> '$.notification_type'
      WHEN 'permission_prompt' THEN 'needs_permission'
      WHEN 'elicitation_dialog' THEN 'needs_input'
      WHEN 'elicitation_url_dialog' THEN 'needs_input'
      WHEN 'agent_needs_input' THEN 'needs_input'
    END
    WHEN 'Stop' THEN 'ready'
    WHEN 'StopFailure' THEN 'errored'
    WHEN 'SessionEnd' THEN 'ended'
  END AS status
) AS new
WHERE id = :payload ->> '$.session_id' AND new.status IS NOT NULL
