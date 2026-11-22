SELECT 'main' AS grid WHERE NOT EXISTS (SELECT 1 FROM ui.tiles WHERE grid = 'main')
