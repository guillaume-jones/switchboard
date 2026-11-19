INSERT OR REPLACE INTO sessions.hidden (session, hidden_at) VALUES (:id, CAST(unixepoch('subsec') * 1000 AS INTEGER));
DELETE FROM sessions.transcripts WHERE session = :id;
DELETE FROM sessions.messages WHERE session = :id;
DELETE FROM sessions.subagents WHERE session = :id
