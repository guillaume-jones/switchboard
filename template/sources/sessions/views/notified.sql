SELECT w.session
FROM sessions_watches w
JOIN sessions_items i ON i.id = w.session
WHERE w.done AND i.unread AND NOT i.hidden
