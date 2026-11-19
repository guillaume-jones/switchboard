SELECT id, due
FROM workstreams.items
WHERE list = 'later' AND done_at IS NULL AND due <= date('now', 'localtime')
