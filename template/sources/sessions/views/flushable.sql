SELECT q.session, q.queued_at
FROM sessions.queue AS q
JOIN sessions_items AS i ON i.id = q.session
LEFT JOIN sessions_served AS sv ON sv.session = q.session
WHERE q.error IS NULL
  AND (q.interject OR sv.run_id IS NOT NULL OR i.status NOT IN ('working', 'needs_permission'))
  AND NOT EXISTS (
    SELECT 1 FROM sessions.sending AS s
    WHERE s.session = q.session
      AND iif(s.sent_at IS NULL, s.started_at, iif(sv.run_id IS NOT NULL, iif(s.acked, NULL, s.sent_at), iif(q.interject, NULL, s.sent_at)))
        > CAST(unixepoch('subsec') * 1000 AS INTEGER) - 300000
  )
