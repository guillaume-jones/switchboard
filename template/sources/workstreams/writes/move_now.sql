UPDATE workstreams.items
SET list = 'default', position = (SELECT coalesce(min(position), 0) - 1 FROM workstreams.items WHERE list = 'default'),
  updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE id = :id AND list = 'later'
