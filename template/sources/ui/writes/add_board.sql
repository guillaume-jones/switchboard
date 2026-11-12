INSERT INTO ui.boards (id, title, component, props, position)
VALUES (:id, :title, :component, :props, (SELECT coalesce(max(position), 0) + 1 FROM ui.boards))
ON CONFLICT (id) DO UPDATE SET title = excluded.title, component = excluded.component, props = excluded.props
