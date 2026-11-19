SELECT CAST(substr(l.ref, 13) AS INTEGER) AS project, i.id, i.list, i.title, i.description, i.due, i.tags, i.position,
  i.done_at IS NOT NULL AS done, i.done_at, i.created_at, i.updated_at
FROM workstreams.links l
JOIN workstreams.items i ON i.id = l.item
WHERE l.kind = 'project'
