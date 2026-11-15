INSERT INTO ui.current (client, board) VALUES (:client, :id)
ON CONFLICT (client) DO UPDATE SET board = excluded.board
