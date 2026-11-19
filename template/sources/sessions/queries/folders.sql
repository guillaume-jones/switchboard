SELECT coalesce(a.cwd, i.cwd) AS cwd, max(i.updated) AS used
FROM sessions_items i
LEFT JOIN sessions.agents a ON a.session = i.id
WHERE coalesce(a.cwd, i.cwd) <> ''
  AND coalesce(a.cwd, i.cwd) || '/' NOT LIKE '%/tmp/%' AND coalesce(a.cwd, i.cwd) || '/' NOT LIKE '%/.claude/%'
GROUP BY 1
ORDER BY used DESC
LIMIT :limit
