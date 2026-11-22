SELECT id, due
FROM workstreams.items
WHERE list IN ('later', 'blocked') AND done_at IS NULL AND due <= date('now', 'localtime')
