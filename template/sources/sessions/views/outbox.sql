SELECT session, iif(error IS NULL, 'queued', 'failed') AS state, text, files,
  (SELECT group_concat(f.value ->> '$.id') FROM json_each(files) AS f) AS attachments,
  interject, queued_at, error, NULL AS run_id, 0 AS acked, NULL AS sent_at
FROM sessions.queue
UNION ALL
SELECT session, 'sending', text, files,
  (SELECT group_concat(f.value ->> '$.id') FROM json_each(files) AS f),
  interject, started_at, NULL, run_id, acked, sent_at
FROM sessions.sending
