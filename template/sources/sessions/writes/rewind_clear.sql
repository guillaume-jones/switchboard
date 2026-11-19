DELETE FROM sessions.messages
WHERE session = :session AND at >= (SELECT at FROM sessions.rewinds WHERE session = :session);
DELETE FROM sessions.rewinds WHERE session = :session
