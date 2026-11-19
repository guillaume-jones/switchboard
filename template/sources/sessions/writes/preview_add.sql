INSERT OR REPLACE INTO sessions.attachments (id, name, data, created_at)
VALUES (:payload ->> '$.id', :payload ->> '$.name', :payload ->> '$.data', CAST(unixepoch('subsec') * 1000 AS INTEGER))
