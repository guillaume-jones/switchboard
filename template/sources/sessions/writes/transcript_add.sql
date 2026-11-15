INSERT OR IGNORE INTO sessions.messages (uuid, session, at, role, text)
SELECT m.value ->> '$.uuid', m.value ->> '$.sessionId', m.value ->> '$.timestamp', m.value ->> '$.type',
  CASE json_type(m.value, '$.message.content')
    WHEN 'text' THEN m.value ->> '$.message.content'
    ELSE (
      SELECT group_concat(CASE c.value ->> '$.type'
        WHEN 'text' THEN c.value ->> '$.text'
        WHEN 'tool_use' THEN '→ ' || (c.value ->> '$.name') || ' ' || substr(c.value ->> '$.input', 1, 300)
        WHEN 'image' THEN '[image]'
        WHEN 'tool_result' THEN '← ' || substr(
          CASE json_type(c.value, '$.content')
            WHEN 'array' THEN (
              SELECT group_concat(CASE t.value ->> '$.type' WHEN 'text' THEN t.value ->> '$.text' WHEN 'image' THEN '[image]' END, ' ')
              FROM json_each(c.value, '$.content') AS t
            )
            ELSE coalesce(c.value ->> '$.content', '')
          END, 1, 300)
      END, char(10) || char(10))
      FROM json_each(m.value, '$.message.content') AS c
    )
  END
FROM json_each(:payload) AS m
WHERE m.value ->> '$.type' IN ('user', 'assistant')
  AND m.value ->> '$.uuid' IS NOT NULL
  AND m.value ->> '$.sessionId' IN (SELECT session FROM sessions.transcripts)
  AND coalesce(m.value ->> '$.isSidechain', 0) = 0
