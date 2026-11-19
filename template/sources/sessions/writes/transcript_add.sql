INSERT OR IGNORE INTO sessions.messages (uuid, session, at, role, tokens, model, tool_id, tool_name, is_error, text)
SELECT uuid, session, at, role, tokens, model, tool_id, tool_name, is_error,
  CASE
    WHEN role = 'user' AND instr(text, 'Sent by the user from Switchboard:' || char(10) || char(10)) > 0 THEN
      substr(text, instr(text, 'Sent by the user from Switchboard:') + 36)
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
  SELECT m.value ->> '$.uuid' AS uuid, m.value ->> '$.parentUuid' AS parent, m.value ->> '$.sessionId' AS session, m.value ->> '$.timestamp' AS at,
    CASE
      WHEN m.value ->> '$.isCompactSummary' THEN 'compact'
      WHEN m.value ->> '$.sourceToolUseID' IS NOT NULL THEN 'skill'
      WHEN m.value ->> '$.type' = 'system' OR m.content ->> '$' LIKE '<local-command-std%' THEN 'command'
      WHEN m.origin ->> '$.kind' = 'task-notification' THEN 'notification'
      WHEN m.origin ->> '$.from' = 'switchboard' THEN 'user'
      WHEN m.origin ->> '$.kind' = 'peer' THEN iif(m.origin ->> '$.handback', 'subagent', 'peer')
      WHEN m.value ->> '$.type' = 'attachment' THEN 'user'
      WHEN m.content ->> '$[0].type' = 'thinking' THEN 'thinking'
      ELSE m.value ->> '$.type'
    END AS role,
    m.value ->> '$.message.usage.input_tokens' + m.value ->> '$.message.usage.cache_creation_input_tokens'
      + m.value ->> '$.message.usage.cache_read_input_tokens' + m.value ->> '$.message.usage.output_tokens' AS tokens,
    m.value ->> '$.message.model' AS model,
    iif(json_type(m.content) = 'array', (SELECT coalesce(c.value ->> '$.id', c.value ->> '$.tool_use_id') FROM json_each(m.content) AS c
      WHERE c.value ->> '$.type' IN ('tool_use', 'tool_result') LIMIT 1), NULL) AS tool_id,
    iif(json_type(m.content) = 'array', (SELECT c.value ->> '$.name' FROM json_each(m.content) AS c
      WHERE c.value ->> '$.type' = 'tool_use' LIMIT 1), NULL) AS tool_name,
    iif(json_type(m.content) = 'array', (SELECT c.value ->> '$.is_error' FROM json_each(m.content) AS c
      WHERE c.value ->> '$.type' = 'tool_result' LIMIT 1), NULL) AS is_error,
    CASE
      WHEN m.origin ->> '$.kind' = 'peer' AND m.origin ->> '$.from' IS NOT 'switchboard' THEN
        coalesce(m.origin ->> '$.handbackReportText', m.origin ->> '$.body')
      WHEN m.value ->> '$.type' = 'system' THEN m.value ->> '$.content'
      WHEN json_type(m.content) = 'text' THEN m.content ->> '$'
      ELSE (
        SELECT group_concat(CASE c.value ->> '$.type'
          WHEN 'text' THEN iif(c.value ->> '$.text' LIKE '<system-reminder>%', NULL, c.value ->> '$.text')
          WHEN 'tool_use' THEN '→ ' || (c.value ->> '$.name') || ' ' || substr(c.value ->> '$.input', 1,
            iif(c.value ->> '$.name' IN ('Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'), 200000, 500))
          WHEN 'thinking' THEN coalesce(m.value ->> '$.message.usage.output_tokens_details.thinking_tokens', '0')
          WHEN 'image' THEN '[image]'
          WHEN 'tool_result' THEN '← ' || substr(
            CASE json_type(c.value, '$.content')
              WHEN 'array' THEN (
                SELECT group_concat(CASE t.value ->> '$.type' WHEN 'text' THEN t.value ->> '$.text' WHEN 'image' THEN '[image]' END, ' ')
                FROM json_each(c.value, '$.content') AS t
              )
              ELSE coalesce(c.value ->> '$.content', '')
            END, 1, 500)
        END, char(10) || char(10))
        FROM json_each(m.content) AS c
      )
    END AS text
  FROM (
    SELECT value,
      iif(value ->> '$.type' = 'attachment', value -> '$.attachment.origin', value -> '$.origin') AS origin,
      iif(value ->> '$.type' = 'attachment', value -> '$.attachment.prompt', value -> '$.message.content') AS content
    FROM json_each(:payload)
  ) AS m
  WHERE (m.value ->> '$.type' IN ('user', 'assistant') OR m.value ->> '$.subtype' = 'local_command'
      OR m.value ->> '$.attachment.type' = 'queued_command')
    AND m.value ->> '$.uuid' IS NOT NULL
    AND m.value ->> '$.sessionId' IN (SELECT session FROM sessions.transcripts)
    AND coalesce(m.value ->> '$.isSidechain', 0) = 0
)
WHERE text NOT LIKE '<local-command-caveat>%' AND text NOT LIKE '<local-command-stdout>Compacted%' AND text NOT LIKE '<system-reminder>%'
  AND NOT (role = 'notification' AND text LIKE '%report was delivered to you as a message from%')
  AND NOT (role = 'thinking' AND (parent IN (SELECT uuid FROM sessions.messages WHERE role = 'thinking')
    OR parent IN (SELECT p.value ->> '$.uuid' FROM json_each(:payload) AS p WHERE p.value ->> '$.message.content[0].type' = 'thinking')))
;
UPDATE sessions.subagents SET done = 1
WHERE id IN (
  SELECT substr(value, instr(value, '<task-id>') + 9, instr(value, '</task-id>') - instr(value, '<task-id>') - 9)
  FROM json_each(:payload)
  WHERE instr(value, '<task-id>') > 0
)
