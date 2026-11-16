INSERT OR IGNORE INTO sessions.messages (uuid, session, at, role, tokens, text)
SELECT uuid, session, at, role, tokens,
  CASE
    WHEN text LIKE '<command-name>%' THEN trim(
      substr(text, 15, instr(text, '</command-name>') - 15) || ' ' ||
      iif(instr(text, '<command-args>') > 0,
        substr(text, instr(text, '<command-args>') + 14, instr(text, '</command-args>') - instr(text, '<command-args>') - 14), ''))
    WHEN role = 'notification' AND instr(text, '<summary>') > 0 THEN
      substr(text, instr(text, '<summary>') + 9, instr(text, '</summary>') - instr(text, '<summary>') - 9)
    WHEN role = 'command' THEN trim(replace(replace(replace(replace(text,
      '<local-command-stdout>', ''), '</local-command-stdout>', ''), '<local-command-stderr>', ''), '</local-command-stderr>', ''))
    ELSE text
  END
FROM (
  SELECT m.value ->> '$.uuid' AS uuid, m.value ->> '$.sessionId' AS session, m.value ->> '$.timestamp' AS at,
    CASE
      WHEN m.value ->> '$.type' = 'system' THEN 'command'
      WHEN m.value ->> '$.origin.kind' = 'task-notification' THEN 'notification'
      WHEN m.value ->> '$.origin.kind' = 'peer' THEN iif(m.value ->> '$.origin.handback', 'subagent', 'peer')
      ELSE m.value ->> '$.type'
    END AS role,
    m.value ->> '$.message.usage.input_tokens' + m.value ->> '$.message.usage.cache_creation_input_tokens'
      + m.value ->> '$.message.usage.cache_read_input_tokens' + m.value ->> '$.message.usage.output_tokens' AS tokens,
    CASE
      WHEN m.value ->> '$.origin.kind' = 'peer' THEN coalesce(m.value ->> '$.origin.handbackReportText', m.value ->> '$.origin.body')
      WHEN m.value ->> '$.type' = 'system' THEN m.value ->> '$.content'
      WHEN json_type(m.value, '$.message.content') = 'text' THEN m.value ->> '$.message.content'
      ELSE (
        SELECT group_concat(CASE c.value ->> '$.type'
          WHEN 'text' THEN iif(c.value ->> '$.text' LIKE '<system-reminder>%', NULL, c.value ->> '$.text')
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
    END AS text
  FROM json_each(:payload) AS m
  WHERE (m.value ->> '$.type' IN ('user', 'assistant') OR m.value ->> '$.subtype' = 'local_command')
    AND m.value ->> '$.uuid' IS NOT NULL
    AND m.value ->> '$.sessionId' IN (SELECT session FROM sessions.transcripts)
    AND coalesce(m.value ->> '$.isSidechain', 0) = 0
)
WHERE text NOT LIKE '<local-command-caveat>%'
