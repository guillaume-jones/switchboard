INSERT INTO workstreams.members (stream_id, ref, component, props, added_by, added_at)
VALUES (:stream_id, :ref, :component, :props, :added_by, CAST(unixepoch('subsec') * 1000 AS INTEGER))
ON CONFLICT (stream_id, ref) DO UPDATE SET component = excluded.component, props = excluded.props;
UPDATE workstreams.streams SET last_activity = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE id = :stream_id;
