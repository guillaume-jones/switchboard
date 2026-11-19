INSERT INTO workstreams.items (list, title, position, created_at, updated_at)
VALUES (:list, :title, (SELECT coalesce(min(position), 0) - 1 FROM workstreams.items WHERE list = :list), CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER));
INSERT INTO workstreams.links (item, ref, kind, label, created_at)
VALUES ((SELECT max(id) FROM workstreams.items), :ref, :kind, nullif(:label, ''), CAST(unixepoch('subsec') * 1000 AS INTEGER))
