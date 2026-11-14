DELETE FROM sessions.transcripts WHERE session = :session;

DELETE FROM sessions.messages WHERE session = :session
