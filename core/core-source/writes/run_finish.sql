UPDATE core.runs SET state = :state, summary = coalesce(:summary, summary), finished_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE id = :id AND state IN ('running', 'open') AND :state IN ('success', 'failure')
