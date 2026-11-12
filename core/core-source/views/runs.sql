SELECT id, command, args, state, parent, depth, rule, pid, summary, git_commit,
  datetime(created_at / 1000, 'unixepoch', 'localtime') AS created,
  datetime(started_at / 1000, 'unixepoch', 'localtime') AS started_at,
  datetime(finished_at / 1000, 'unixepoch', 'localtime') AS finished_at
FROM core.runs
