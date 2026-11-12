SELECT id, title, state, datetime(last_activity / 1000, 'unixepoch', 'localtime') AS last_activity
FROM workstreams.streams
ORDER BY last_activity DESC
