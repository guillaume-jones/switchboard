SELECT kind, id, datetime(at / 1000, 'unixepoch', 'localtime') AS time, name, detail FROM (
  SELECT kind, id, at, name, detail FROM (SELECT 'run' AS kind, id, created_at AS at, command AS name, state AS detail FROM core.runs ORDER BY created_at DESC LIMIT :limit)
  UNION ALL
  SELECT kind, id, at, name, detail FROM (SELECT 'firing' AS kind, CAST(id AS TEXT) AS id, at, rule AS name, coalesce(blocked, key) AS detail FROM core.firings ORDER BY at DESC LIMIT :limit)
  UNION ALL
  SELECT kind, id, at, name, detail FROM (SELECT kind, CAST(id AS TEXT) AS id, at, name, message AS detail FROM core.events ORDER BY at DESC LIMIT :limit)
)
ORDER BY at DESC
LIMIT :limit
