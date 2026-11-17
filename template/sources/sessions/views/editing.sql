SELECT id, cwd FROM sessions_items
WHERE status IN ('working', 'needs_permission', 'needs_input')
  AND (live OR updated > datetime('now', '-10 minutes', 'localtime'))
