SELECT id, rule, key, run_id, datetime(at / 1000, 'unixepoch', 'localtime') AS time, blocked, git_commit
FROM core.firings
