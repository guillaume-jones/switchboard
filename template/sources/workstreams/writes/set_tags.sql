INSERT INTO workstreams.tags (name, created_at)
SELECT value, CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM json_each(:tags) WHERE true
ON CONFLICT (name) DO NOTHING;
UPDATE workstreams.items SET tags = json(:tags), updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE id = :id
