SELECT ref, kind, label, title, status, updated FROM (
  SELECT 'sessions:' || id AS ref, 'session' AS kind, title AS label, title, status, updated
  FROM sessions_items
  WHERE NOT hidden
  UNION ALL
  SELECT 'workstreams:' || id, 'project', title, title, NULL, datetime(updated_at / 1000, 'unixepoch', 'localtime')
  FROM workstreams.items
  WHERE list = 'projects' AND done_at IS NULL
)
WHERE title LIKE '%' || :text || '%'
ORDER BY updated DESC
LIMIT :limit
