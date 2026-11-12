UPDATE attention.items SET snooze_until = :until
WHERE ref = :ref AND cleared_at IS NULL
