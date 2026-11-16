INSERT OR IGNORE INTO sessions.attachments (id, name, data, created_at)
VALUES (:id, :name, :data, CAST(unixepoch('subsec') * 1000 AS INTEGER))
