SELECT rule AS id, 'rule ' || rule || coalesce(' (disabled: ' || disabled_reason || ')', '') AS title
FROM core.rules
