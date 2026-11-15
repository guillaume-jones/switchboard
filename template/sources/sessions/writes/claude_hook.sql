INSERT INTO sessions.items (id, agent, title, status, cwd, run_id, raw, created_at, updated_at, host, entrypoint, last_message, last_prompt, decision)
VALUES (
  :payload ->> '$.session_id',
  'claude',
  substr(:payload ->> '$.prompt', 1, 200),
  'ready',
  :payload ->> '$.cwd',
  :run_id,
  :payload,
  CAST(unixepoch('subsec') * 1000 AS INTEGER),
  CAST(unixepoch('subsec') * 1000 AS INTEGER),
  nullif(:host, ''),
  nullif(:entrypoint, ''),
  iif(:payload ->> '$.hook_event_name' = 'Stop', :payload ->> '$.last_assistant_message', NULL),
  iif(:payload ->> '$.hook_event_name' = 'UserPromptSubmit', :payload ->> '$.prompt', NULL),
  iif(:payload ->> '$.hook_event_name' = 'PermissionRequest', json_object(
    'tool_name', :payload ->> '$.tool_name',
    'tool_input', json(:payload -> '$.tool_input'),
    'at', CAST(unixepoch('subsec') * 1000 AS INTEGER)
  ), NULL)
)
ON CONFLICT (id) DO UPDATE SET
  title = coalesce(title, excluded.title),
  cwd = excluded.cwd,
  run_id = coalesce(excluded.run_id, run_id),
  raw = excluded.raw,
  updated_at = excluded.updated_at,
  host = coalesce(host, excluded.host),
  entrypoint = coalesce(entrypoint, excluded.entrypoint),
  last_message = coalesce(excluded.last_message, last_message),
  last_prompt = coalesce(excluded.last_prompt, last_prompt),
  decision = coalesce(excluded.decision, decision),
  answer = iif(excluded.decision IS NULL, answer, NULL);

UPDATE sessions.items SET
  status = new.status,
  decision = iif(new.status IN ('needs_permission', 'needs_input'), decision, NULL),
  answer = iif(new.status IN ('needs_permission', 'needs_input'), answer, NULL)
FROM (
  SELECT CASE :payload ->> '$.hook_event_name'
    WHEN 'SessionStart' THEN iif(:payload ->> '$.source' = 'compact', NULL, 'ready')
    WHEN 'UserPromptSubmit' THEN 'working'
    WHEN 'PreToolUse' THEN iif(:payload ->> '$.tool_name' IN ('AskUserQuestion', 'ExitPlanMode'), 'needs_input', 'working')
    WHEN 'PermissionRequest' THEN iif(:payload ->> '$.tool_name' IN ('AskUserQuestion', 'ExitPlanMode'), 'needs_input', 'needs_permission')
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
