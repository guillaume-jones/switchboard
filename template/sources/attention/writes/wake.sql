UPDATE attention.items SET snooze_until = NULL, woken_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE snooze_until <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
