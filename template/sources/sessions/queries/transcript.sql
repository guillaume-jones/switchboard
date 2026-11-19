SELECT uuid, at, role, text, tokens, model, tool_id, tool_name, is_error FROM (
  SELECT uuid, at, role, text, tokens, model, tool_id, tool_name, is_error FROM sessions.messages
  WHERE session = :session AND text IS NOT NULL AND text != ''
    AND at < coalesce((SELECT at FROM sessions.rewinds WHERE session = :session), '~')
  ORDER BY at DESC
  LIMIT :limit
)
ORDER BY at
