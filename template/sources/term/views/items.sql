SELECT t.name, t.cwd, t.chat, t.attached, t.created, s.title AS chat_title
FROM term.sessions t LEFT JOIN sessions_items s ON s.id = t.chat
