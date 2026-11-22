UPDATE workstreams.items SET
  title = iif(:field = 'title', :value, title),
  description = iif(:field = 'description', :value, description),
  due = iif(:field = 'due', nullif(:value, ''), due),
  folder = iif(:field = 'folder', nullif(:value, ''), folder),
  notes_file = iif(:field = 'notes_file', nullif(trim(:value), ''), notes_file),
  updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE id = :id AND :field IN ('title', 'description', 'due', 'folder', 'notes_file');
-- a to-do given a date past tomorrow waits in Later, until that date moves it back to Now
UPDATE workstreams.items
SET list = 'later', position = (SELECT coalesce(min(position), 0) - 1 FROM workstreams.items WHERE list = 'later')
WHERE id = :id AND :field = 'due' AND list = 'default' AND done_at IS NULL AND date(:value) > date('now', 'localtime', '+1 day')
