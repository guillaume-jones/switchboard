INSERT INTO sessions.agents (session, short_id, kind, state, name, cwd, live, started_at, changed_at)
SELECT a.value ->> '$.sessionId', a.value ->> '$.id', a.value ->> '$.kind',
  iif(a.value ->> '$.kind' = 'background', a.value ->> '$.state', a.value ->> '$.status'),
  a.value ->> '$.name', a.value ->> '$.cwd',
  a.value ->> '$.kind' = 'interactive' OR a.value ->> '$.pid' IS NOT NULL,
  a.value ->> '$.startedAt', coalesce(a.value ->> '$.startedAt', CAST(unixepoch('subsec') * 1000 AS INTEGER))
FROM json_each(:payload) AS a
WHERE a.value ->> '$.sessionId' IS NOT NULL
ON CONFLICT (session) DO UPDATE SET
  short_id = coalesce(excluded.short_id, short_id),
  kind = excluded.kind,
  state = excluded.state,
  name = coalesce(excluded.name, name),
  cwd = coalesce(excluded.cwd, cwd),
  live = excluded.live,
  changed_at = excluded.changed_at
WHERE state IS NOT excluded.state OR live IS NOT excluded.live OR name IS NOT coalesce(excluded.name, name);
UPDATE sessions.agents SET live = 0, state = iif(kind = 'interactive', 'ended', state), changed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE live = 1 AND session NOT IN (SELECT a.value ->> '$.sessionId' FROM json_each(:payload) AS a WHERE a.value ->> '$.sessionId' IS NOT NULL)
