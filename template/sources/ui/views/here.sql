SELECT c.client, c.board, iif(b.component = 'Transcript', coalesce(b.props ->> '$.session', ''), NULL) AS session
FROM ui.current c JOIN ui.boards b ON b.id = c.board
