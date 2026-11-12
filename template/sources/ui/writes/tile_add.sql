INSERT INTO ui.tiles (grid, id, component, props, x, y, w, h)
VALUES (:grid, :id, :component, :props, 0, (SELECT coalesce(max(y + h), 0) FROM ui.tiles WHERE grid = :grid), 6, 6)
