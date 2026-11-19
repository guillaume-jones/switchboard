SELECT c.cwd, c.name, u.used_at
FROM sessions.commands c
LEFT JOIN sessions.command_uses u ON u.name = c.name
ORDER BY u.used_at DESC NULLS LAST, c.name
