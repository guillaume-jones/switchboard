INSERT INTO ui.boards (id, title, component, props, position)
VALUES ('main', 'Main', 'Grid', '{"grid":"main"}', 0)
ON CONFLICT (id) DO NOTHING;
INSERT INTO ui.boards (id, title, component, props, position)
VALUES (:id, :title, :component, :props, (SELECT coalesce(max(position), 0) + 1 FROM ui.boards))
ON CONFLICT (id) DO UPDATE SET title = excluded.title;
INSERT INTO ui.current (client, board) VALUES (:client, :id)
ON CONFLICT (client) DO UPDATE SET board = excluded.board
