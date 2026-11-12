SELECT id, ref, reason, level,
  CASE WHEN cleared_at IS NOT NULL THEN 'cleared' WHEN snooze_until IS NOT NULL THEN 'snoozed' ELSE 'open' END AS state,
  datetime(created_at / 1000, 'unixepoch', 'localtime') AS created,
  datetime(cleared_at / 1000, 'unixepoch', 'localtime') AS cleared,
  datetime(snooze_until / 1000, 'unixepoch', 'localtime') AS snooze_until,
  woken_at
FROM attention.items
