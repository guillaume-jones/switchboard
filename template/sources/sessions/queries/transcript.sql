SELECT uuid, at, role, text, tokens FROM (
  SELECT uuid, at, role, text, tokens FROM sessions.messages
  WHERE session = :session AND text IS NOT NULL AND text != ''
  ORDER BY at DESC
  LIMIT :limit
)
ORDER BY at
