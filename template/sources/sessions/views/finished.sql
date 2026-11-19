SELECT session, armed_at, title, replace(status, '_', ' ') AS status FROM sessions_watches WHERE done
