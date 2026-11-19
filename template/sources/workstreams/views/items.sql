SELECT id, list, title, description, due, tags, position, done_at IS NOT NULL AS done, done_at, created_at, updated_at, folder
FROM workstreams.items
