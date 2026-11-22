INSERT INTO github.prs (url, repo, number, title, state, draft, review_decision, merge_state, ci, new_comments, folder, created_at, closed_at, raw, fetched_at)
SELECT p.value ->> '$.url', p.value ->> '$.repo', p.value ->> '$.number', p.value ->> '$.title', p.value ->> '$.state',
  p.value ->> '$.draft', p.value ->> '$.review_decision', p.value ->> '$.merge_state', p.value ->> '$.ci',
  p.value ->> '$.new_comments', p.value ->> '$.folder', p.value ->> '$.created_at', p.value ->> '$.closed_at', p.value ->> '$.raw',
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM json_each(:payload) AS p
WHERE true
ON CONFLICT (url) DO UPDATE SET
  title = excluded.title, state = excluded.state, draft = excluded.draft, review_decision = excluded.review_decision,
  merge_state = excluded.merge_state, ci = excluded.ci, new_comments = excluded.new_comments, folder = excluded.folder,
  closed_at = excluded.closed_at, raw = excluded.raw, fetched_at = excluded.fetched_at
