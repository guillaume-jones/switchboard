INSERT OR REPLACE INTO sessions.sending (session, text, files, interject, run_id, started_at)
SELECT session, text, files, interject, :run_id, CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM sessions.queue
WHERE session = :session AND queued_at = :queued_at AND error IS NULL;
DELETE FROM sessions.queue WHERE session = :session AND queued_at = :queued_at AND error IS NULL
