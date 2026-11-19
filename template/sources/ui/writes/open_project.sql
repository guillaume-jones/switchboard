INSERT INTO ui.boards (id, title, component, props, position)
SELECT 'project:' || p.id, p.title, 'Project', json_object('project', p.id), (SELECT coalesce(max(position), 0) + 1 FROM ui.boards)
FROM workstreams_items p
WHERE p.list = 'projects' AND p.id = (SELECT max(id) FROM workstreams_items WHERE list = 'projects' AND (id = :project OR :project = 0))
ON CONFLICT (id) DO UPDATE SET title = excluded.title;
INSERT INTO ui.cursor (client, seq) VALUES (:client, 0)
ON CONFLICT (client) DO NOTHING;
INSERT INTO ui.history (client, seq, board, session)
SELECT client, 0, board, session FROM ui_here
WHERE client = :client AND NOT EXISTS (SELECT 1 FROM ui.history WHERE client = :client);
DELETE FROM ui.history WHERE client = :client AND seq > (SELECT seq FROM ui.cursor WHERE client = :client);
INSERT INTO ui.history (client, seq, board, session)
SELECT :client, (SELECT seq FROM ui.cursor WHERE client = :client) + 1, t.board, t.session
FROM (SELECT 'project:' || max(id) AS board, NULL AS session FROM workstreams_items WHERE list = 'projects' AND (id = :project OR :project = 0)) AS t
WHERE t.board IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ui.history h JOIN ui.cursor c ON c.client = h.client AND c.seq = h.seq
WHERE h.client = :client AND h.board = t.board AND h.session IS t.session);
UPDATE ui.cursor SET seq = coalesce((SELECT max(seq) FROM ui.history WHERE client = :client), seq) WHERE client = :client;
DELETE FROM ui.history WHERE client = :client AND seq <= (SELECT seq FROM ui.cursor WHERE client = :client) - 100;
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
