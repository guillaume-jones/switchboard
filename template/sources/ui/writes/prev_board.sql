WITH here AS (
  SELECT coalesce(
    (SELECT b.position FROM ui.boards b JOIN ui.current c ON c.id = 1 AND c.board = b.id),
    (SELECT min(position) FROM ui.boards)
  ) AS position
)
INSERT INTO ui.current (id, board)
SELECT 1, coalesce(
  (SELECT id FROM ui.boards WHERE position < (SELECT position FROM here) ORDER BY position DESC LIMIT 1),
  (SELECT id FROM ui.boards ORDER BY position DESC LIMIT 1)
)
WHERE true
ON CONFLICT (id) DO UPDATE SET board = excluded.board
