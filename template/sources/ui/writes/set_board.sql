INSERT INTO ui.current (id, board) VALUES (1, :id)
ON CONFLICT (id) DO UPDATE SET board = excluded.board
