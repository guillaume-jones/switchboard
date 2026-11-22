SELECT p.id AS project, l.ref, l.kind, l.label, l.title, l.status, l.archived, l.item, l.item_title,
  l.item = p.id AS own, min(l.created_at) AS created_at
FROM workstreams.items p
JOIN workstreams_links l ON l.item = p.id
  OR l.item IN (SELECT m.item FROM workstreams.links m WHERE m.kind = 'project' AND m.ref = 'workstreams:' || p.id)
WHERE p.list = 'projects' AND l.kind <> 'project'
GROUP BY p.id, l.ref
