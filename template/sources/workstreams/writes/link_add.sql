INSERT INTO workstreams.links (item, ref, kind, label, created_at)
VALUES (:item, :ref, :kind, nullif(:label, ''), CAST(unixepoch('subsec') * 1000 AS INTEGER))
ON CONFLICT (item, ref) DO NOTHING
