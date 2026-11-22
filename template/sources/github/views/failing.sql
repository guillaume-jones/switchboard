SELECT p.url AS id, p.url, p.title, p.folder,
  p.raw ->> '$.commits.nodes[0].commit.oid' AS head_sha,
  concat_ws(' and ', iif(p.ci IN ('FAILURE', 'ERROR'), 'failing CI', NULL), iif(p.merge_state = 'DIRTY', 'merge conflicts', NULL)) AS problem
FROM github.prs p
WHERE p.state = 'OPEN' AND p.folder IS NOT NULL
  AND p.raw ->> '$.commits.nodes[0].commit.oid' IS NOT NULL
  AND (p.ci IN ('FAILURE', 'ERROR') OR p.merge_state = 'DIRTY')
  AND coalesce(p.ci, '') NOT IN ('PENDING', 'EXPECTED')
