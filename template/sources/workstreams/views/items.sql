SELECT id, list, title, description, due, position, done_at IS NOT NULL AS done, done_at, created_at, updated_at, folder, notes_file
FROM workstreams.items
