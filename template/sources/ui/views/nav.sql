SELECT b.id AS board, NULL AS session, CASE WHEN b.component = 'Terminal' THEN 2000000 ELSE 0 END + row_number() OVER (ORDER BY b.position) AS seq
FROM ui.boards b
WHERE b.component NOT IN ('Transcript', 'Project')
  AND (b.component <> 'Terminal' OR b.props ->> '$.name' IN (SELECT t.name FROM term_items t))
UNION ALL
SELECT b.id, NULL, 500000 + row_number() OVER (ORDER BY p.position)
FROM ui.boards b
JOIN workstreams_items p ON p.id = b.props ->> '$.project' AND p.list = 'projects' AND NOT p.done
WHERE b.component = 'Project'
UNION ALL
SELECT NULL, '', 1000000
UNION ALL
SELECT NULL, s.id, 1000000 + row_number() OVER (ORDER BY s.created DESC)
FROM (SELECT id, created FROM sessions_items WHERE hidden = 0 ORDER BY created DESC LIMIT 50) AS s
