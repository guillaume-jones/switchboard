WITH here AS (
  SELECT coalesce(
    (SELECT b.position FROM ui.boards b JOIN ui.current c ON c.client = :client AND c.board = b.id),
    (SELECT min(position) FROM ui.boards)
  ) AS position
)
INSERT INTO ui.current (client, board)
SELECT :client, coalesce(
  (SELECT id FROM ui.boards WHERE position < (SELECT position FROM here) ORDER BY position DESC LIMIT 1),
  (SELECT id FROM ui.boards ORDER BY position DESC LIMIT 1)
)
WHERE true
ON CONFLICT (client) DO UPDATE SET board = excluded.board
