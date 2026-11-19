SELECT l.item, l.ref, l.kind, l.label, coalesce(s.title, pj.title, l.label, l.ref) AS title, s.status, i.title AS item_title,
  i.list AS item_list, i.done_at IS NOT NULL AS item_done, coalesce(s.hidden, 0) AS archived, l.created_at
FROM workstreams.links l
JOIN workstreams.items i ON i.id = l.item
LEFT JOIN sessions_items s ON l.kind = 'session' AND s.id = substr(l.ref, 10)
LEFT JOIN workstreams.items pj ON l.kind = 'project' AND pj.id = CAST(substr(l.ref, 13) AS INTEGER)
ORDER BY l.created_at
