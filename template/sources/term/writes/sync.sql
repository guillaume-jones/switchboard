DELETE FROM term.sessions WHERE name NOT IN (SELECT value ->> '$.name' FROM json_each(:payload));
INSERT INTO term.sessions (name, cwd, chat, attached, created)
SELECT value ->> '$.name', value ->> '$.cwd', nullif(value ->> '$.chat', ''), value ->> '$.attached', value ->> '$.created'
FROM json_each(:payload) WHERE true
ON CONFLICT (name) DO UPDATE SET cwd = excluded.cwd, chat = excluded.chat, attached = excluded.attached, created = excluded.created
WHERE (cwd, chat, attached, created) IS NOT (excluded.cwd, excluded.chat, excluded.attached, excluded.created)
