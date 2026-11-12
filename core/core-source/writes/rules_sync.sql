INSERT INTO core.rules (rule, last_evaluated)
SELECT value, CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM json_each(:payload) WHERE true
ON CONFLICT (rule) DO NOTHING;
DELETE FROM core.rules WHERE rule NOT IN (SELECT value FROM json_each(:payload));
