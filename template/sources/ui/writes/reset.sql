DELETE FROM ui.tiles WHERE grid = :grid;
INSERT INTO ui.tiles (grid, id, component, props, x, y, w, h)
SELECT grid, id, component, props, x, y, w, h FROM ui_defaults WHERE grid = :grid
