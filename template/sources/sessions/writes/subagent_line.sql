INSERT INTO sessions.subagents (id, session, activity, started_at, updated_at, done)
SELECT id, session, activity, at, at, done FROM (
  SELECT l.value ->> '$.agentId' AS id, l.value ->> '$.sessionId' AS session, l.value ->> '$.timestamp' AS at,
    CASE l.value ->> '$.type'
      WHEN 'assistant' THEN l.value ->> '$.message.stop_reason' IS 'end_turn'
      WHEN 'user' THEN 0
    END AS done,
    (SELECT trim((c.value ->> '$.name') || ' ' || coalesce(c.value ->> '$.input.description', c.value ->> '$.input.command',
        c.value ->> '$.input.file_path', c.value ->> '$.input.pattern', c.value ->> '$.input.query', c.value ->> '$.input.url', c.value ->> '$.input.skill', ''))
      FROM json_each(l.value, '$.message.content') AS c
      WHERE l.value ->> '$.type' = 'assistant' AND json_type(l.value, '$.message.content') = 'array' AND c.value ->> '$.type' = 'tool_use'
      ORDER BY c.key DESC LIMIT 1) AS activity
  FROM json_each(:payload) AS l
)
WHERE id IS NOT NULL AND session IN (SELECT session FROM sessions.transcripts)
ON CONFLICT (id) DO UPDATE SET
  activity = coalesce(excluded.activity, activity),
  started_at = coalesce(started_at, excluded.started_at),
  updated_at = coalesce(excluded.updated_at, updated_at),
  done = coalesce(excluded.done, done)
