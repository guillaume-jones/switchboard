INSERT INTO sessions.queue (session, text, files, interject, queued_at, error)
SELECT session, text, files, 0, CAST(unixepoch('subsec') * 1000 AS INTEGER), :error FROM sessions.sending
WHERE session = :session AND run_id IS :run_id AND :state = 'failed'
ON CONFLICT (session) DO UPDATE SET
  text = excluded.text || char(10) || char(10) || text,
  files = (SELECT json_group_array(json(f.value)) FROM (SELECT value FROM json_each(excluded.files) UNION ALL SELECT value FROM json_each(files)) AS f),
  queued_at = excluded.queued_at,
  error = excluded.error;
DELETE FROM sessions.sending WHERE session = :session AND run_id IS :run_id AND :state IN ('failed', 'delivered');
UPDATE sessions.sending SET sent_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE session = :session AND run_id IS :run_id AND :state = 'sent'
