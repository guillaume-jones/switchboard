SELECT b.id, b.title, b.component, b.props, coalesce(b.id = c.board, 0) AS current
FROM ui.boards b LEFT JOIN ui.current c ON c.client = :client
ORDER BY b.position
