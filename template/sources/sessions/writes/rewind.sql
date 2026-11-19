INSERT OR REPLACE INTO sessions.rewinds (session, uuid, at)
SELECT session, uuid, at FROM sessions.messages WHERE uuid = :uuid AND session = :session
