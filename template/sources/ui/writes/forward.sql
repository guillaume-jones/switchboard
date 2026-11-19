UPDATE ui.cursor SET seq = coalesce((
  SELECT min(h.seq) FROM ui.history h
  WHERE h.client = :client AND h.seq > ui.cursor.seq
    AND EXISTS (SELECT 1 FROM ui_nav n WHERE n.board = h.board OR n.session = h.session)
), seq)
WHERE client = :client;
INSERT INTO ui.boards (id, title, component, props, position)
VALUES ('main', 'Main', 'Grid', '{"grid":"main"}', 0)
ON CONFLICT (id) DO NOTHING;
INSERT INTO ui.boards (id, title, component, props, position)
SELECT h.board, 'Chat', 'Transcript', json_object('session', nullif(h.session, '')), (SELECT coalesce(max(position), 0) + 1 FROM ui.boards)
FROM ui.history h JOIN ui.cursor c ON c.client = h.client AND c.seq = h.seq
WHERE h.client = :client AND h.session IS NOT NULL
ON CONFLICT (id) DO UPDATE SET props = excluded.props;
INSERT INTO ui.current (client, board)
SELECT h.client, h.board
FROM ui.history h JOIN ui.cursor c ON c.client = h.client AND c.seq = h.seq
WHERE h.client = :client
ON CONFLICT (client) DO UPDATE SET board = excluded.board
