DELETE FROM workstreams.links WHERE item = :id OR (kind = 'project' AND ref = 'workstreams:' || :id);
DELETE FROM workstreams.items WHERE id = :id
