SELECT session, armed_at, title, replace(status, '_', ' ') AS status,
  CASE status WHEN 'ready' THEN 'Finished' WHEN 'errored' THEN 'Errored' WHEN 'stopped' THEN 'Stopped' ELSE 'Ended' END AS outcome
FROM sessions_watches WHERE done
