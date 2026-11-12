SELECT id, datetime(at / 1000, 'unixepoch', 'localtime') AS time, kind, name, trigger, run_id, message, git_commit
FROM core.events
WHERE kind = :kind
ORDER BY id DESC
LIMIT :limit
