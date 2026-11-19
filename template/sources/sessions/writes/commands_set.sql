DELETE FROM sessions.commands WHERE cwd = :cwd;

INSERT INTO sessions.commands (cwd, name)
SELECT :cwd, value FROM json_each(:payload)
