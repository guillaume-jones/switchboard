SELECT name FROM workstreams.tags
UNION
SELECT column1 FROM (VALUES ('blocked'), ('on hold'), ('background'))
