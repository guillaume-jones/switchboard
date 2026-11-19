INSERT INTO sessions.items (id, agent, title, status, cwd, run_id, raw, created_at, updated_at, host, entrypoint, last_message, last_prompt, decision, origin)
SELECT
  :payload ->> '$.session_id',
  'claude',
  coalesce(:payload ->> '$.title', substr(:payload ->> '$.prompt', 1, 200)),
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
  ), NULL),
  coalesce(:payload ->> '$.origin', iif(:host IS 'switchboard', NULL, iif(:entrypoint = 'sdk-cli', 'automation', 'me')))
WHERE :payload ->> '$.hook_event_name' NOT IN ('SessionStart', 'SessionEnd')
  OR :host IS 'switchboard'
  OR EXISTS (SELECT 1 FROM sessions.items WHERE id = :payload ->> '$.session_id')
ON CONFLICT (id) DO UPDATE SET
  title = iif(:payload ->> '$.title' IS NULL, coalesce(title, excluded.title), excluded.title),
  cwd = excluded.cwd,
  run_id = coalesce(excluded.run_id, run_id),
  raw = excluded.raw,
  updated_at = excluded.updated_at,
  host = coalesce(excluded.host, host),
  entrypoint = coalesce(entrypoint, excluded.entrypoint),
  origin = coalesce(origin, excluded.origin),
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
    WHEN 'Stop' THEN iif(:payload ->> '$.tasks' > 0, 'waiting', 'ready')
    WHEN 'StopFailure' THEN 'errored'
    WHEN 'SessionEnd' THEN 'ended'
  END AS status
) AS new
WHERE id = :payload ->> '$.session_id' AND new.status IS NOT NULL;

UPDATE sessions.sending SET acked = 1
WHERE session = :payload ->> '$.session_id' AND :payload ->> '$.hook_event_name' = 'UserPromptSubmit';

DELETE FROM sessions.sending
WHERE session = :payload ->> '$.session_id' AND :payload ->> '$.hook_event_name' IN ('Stop', 'StopFailure', 'SessionEnd')
  AND (acked OR sent_at IS NOT NULL)
;

DELETE FROM sessions.folders
WHERE session = :payload ->> '$.session_id' AND cwd = :payload ->> '$.cwd';

INSERT OR IGNORE INTO sessions.hidden (session, hidden_at)
SELECT id, created_at FROM sessions.items
WHERE id = :payload ->> '$.session_id' AND created_at = updated_at
  AND (origin IS 'automation' OR (run_id IS NULL AND coalesce(host, '') NOT IN ('switchboard', 'dev.switchboard.app')));

UPDATE sessions.watches SET armed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE session = :payload ->> '$.session_id' AND sticky AND :payload ->> '$.hook_event_name' = 'UserPromptSubmit';

INSERT OR IGNORE INTO sessions.watches (session, armed_at)
SELECT id, created_at FROM sessions.items
WHERE id = :payload ->> '$.session_id' AND origin IS 'me' AND host IN ('switchboard', 'dev.switchboard.app') AND created_at = updated_at
