UPDATE workstreams.items SET done_at = iif(:done, coalesce(done_at, CAST(unixepoch('subsec') * 1000 AS INTEGER)), NULL), updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE id = :id
