SELECT w.session, w.armed_at, w.sticky, i.title, i.status,
  i.status IN ('ready', 'errored', 'ended', 'stopped')
    AND max(coalesce(s.updated_at, 0), coalesce(a.changed_at, 0)) > w.armed_at AS done
FROM sessions.watches w
JOIN sessions_items i ON i.id = w.session
LEFT JOIN sessions.items s ON s.id = w.session
LEFT JOIN sessions.agents a ON a.session = w.session
