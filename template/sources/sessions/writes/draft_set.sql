DELETE FROM sessions.drafts WHERE key = :key AND :text = '';
INSERT INTO sessions.drafts (key, text, updated_at)
SELECT :key, :text, CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE :text <> ''
ON CONFLICT (key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
