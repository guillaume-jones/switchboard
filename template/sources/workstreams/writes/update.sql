UPDATE workstreams.items SET
  title = iif(:field = 'title', :value, title),
  description = iif(:field = 'description', :value, description),
  due = iif(:field = 'due', nullif(:value, ''), due),
  folder = iif(:field = 'folder', nullif(:value, ''), folder),
  updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE id = :id AND :field IN ('title', 'description', 'due', 'folder')
