INSERT INTO core.events (at, kind, name, trigger, run_id, message, git_commit)
VALUES (CAST(unixepoch('subsec') * 1000 AS INTEGER), :kind, :name, :trigger, :run_id, :message, :git_commit)
