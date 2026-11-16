SELECT id, decision ->> '$.at' AS decision_at,
  coalesce(replace(cwd, rtrim(cwd, replace(cwd, '/', '')), ''), 'Claude') AS folder,
  iif(status = 'needs_input', 'Needs input', 'Permission: ' || (decision ->> '$.tool_name')) AS reason
FROM sessions.items
WHERE status IN ('needs_permission', 'needs_input') AND decision IS NOT NULL AND answer IS NULL
