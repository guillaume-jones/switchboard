-- Terminals whose chat was archived, once per archiving: term.release ends or unlinks them.
SELECT t.name, a.hidden_at FROM term.sessions t JOIN sessions_archived a ON a.session = t.chat
