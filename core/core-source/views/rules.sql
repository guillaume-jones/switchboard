SELECT rule, enabled, disabled_reason, datetime(last_evaluated / 1000, 'unixepoch', 'localtime') AS last_evaluated
FROM core.rules
