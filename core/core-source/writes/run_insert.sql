INSERT INTO core.runs (id, command, args, state, parent, depth, rule, git_commit, created_at)
VALUES (:id, :command, :args, 'queued', :parent, :depth, :rule, :git_commit, CAST(unixepoch('subsec') * 1000 AS INTEGER))
