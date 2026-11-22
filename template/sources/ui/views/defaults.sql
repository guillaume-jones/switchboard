SELECT column1 AS grid, column2 AS id, column3 AS component, column4 AS props, column5 AS x, column6 AS y, column7 AS w, column8 AS h
FROM (VALUES
  ('main', 'todo', 'Todo', '{}', 0, 0, 12, 16),
  ('main', 'prs', 'PRs', '{}', 12, 0, 12, 16)
)
UNION ALL
SELECT 'project:' || p.id, t.column1, t.column2, json_object('project', p.id), t.column3, t.column4, t.column5, t.column6
FROM workstreams_items p, (VALUES
  ('todo', 'Todo', 0, 0, 12, 14),
  ('links', 'ProjectLinks', 12, 0, 12, 14),
  ('prs', 'PRs', 0, 14, 12, 8),
  ('notes', 'ProjectNotes', 12, 14, 12, 8)
) AS t
WHERE p.list = 'projects'
