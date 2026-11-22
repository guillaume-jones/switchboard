SELECT id, list, title, description, due, position, done_at IS NOT NULL AS done, done_at, created_at
FROM workstreams.items
WHERE list IN ('default', 'later', 'blocked')
