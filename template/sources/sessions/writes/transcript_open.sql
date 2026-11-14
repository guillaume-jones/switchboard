INSERT OR REPLACE INTO sessions.transcripts (session, opened_at)
VALUES (:session, CAST(unixepoch('subsec') * 1000 AS INTEGER));

DELETE FROM sessions.messages WHERE session = :session
