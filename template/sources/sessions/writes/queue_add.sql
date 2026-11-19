INSERT INTO sessions.queue (session, text, files, interject, queued_at)
VALUES (:session, :text, :files, 0, CAST(unixepoch('subsec') * 1000 AS INTEGER))
ON CONFLICT (session) DO UPDATE SET
  text = text || char(10) || char(10) || excluded.text,
  files = (SELECT json_group_array(json(f.value)) FROM (SELECT value FROM json_each(files) UNION ALL SELECT value FROM json_each(excluded.files)) AS f),
  queued_at = excluded.queued_at,
  error = NULL;
DELETE FROM sessions.hidden WHERE session = :session
