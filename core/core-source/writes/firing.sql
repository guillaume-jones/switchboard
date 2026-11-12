INSERT OR IGNORE INTO core.firings (rule, key, at, git_commit)
VALUES (:rule, :key, CAST(unixepoch('subsec') * 1000 AS INTEGER), :git_commit)
