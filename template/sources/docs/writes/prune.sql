DELETE FROM docs.files WHERE read_at < CAST((unixepoch('subsec') - 30 * 86400) * 1000 AS INTEGER)
