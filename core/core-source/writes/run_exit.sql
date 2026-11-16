UPDATE core.runs SET state = :state, summary = :summary,
  finished_at = CASE WHEN :state = 'open' THEN NULL ELSE CAST(unixepoch('subsec') * 1000 AS INTEGER) END
WHERE id = :id AND state IN ('queued', 'running') AND :state IN ('success', 'failure', 'open', 'stopped')
