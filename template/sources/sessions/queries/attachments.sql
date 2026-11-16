SELECT a.id, a.name, a.data FROM sessions.attachments a WHERE a.id IN (SELECT value FROM json_each(:ids))
