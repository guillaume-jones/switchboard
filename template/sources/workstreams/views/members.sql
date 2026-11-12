SELECT stream_id, ref, component, props, added_by, datetime(added_at / 1000, 'unixepoch', 'localtime') AS added_at
FROM workstreams.members
ORDER BY added_at
