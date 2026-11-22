INSERT INTO docs.files (path, text, error, read_at)
VALUES (:payload ->> '$.path', :payload ->> '$.text', :payload ->> '$.error', CAST(unixepoch('subsec') * 1000 AS INTEGER))
ON CONFLICT (path) DO UPDATE SET text = excluded.text, error = excluded.error, read_at = excluded.read_at
