SELECT p.url AS id, p.url, p.repo, p.number, p.title, p.ci, p.merge_state, p.new_comments, p.folder,
  p.raw ->> '$.autoMergeRequest.enabledAt' IS NOT NULL AS auto_merge, coalesce(p.raw ->> '$.isInMergeQueue', 0) AS queued,
  p.created_at, p.closed_at, p.state = 'OPEN' AS is_open,
  CASE
    WHEN p.state <> 'OPEN' THEN lower(p.state)
    WHEN p.draft THEN 'draft'
    WHEN p.ci IN ('FAILURE', 'ERROR') OR p.merge_state = 'DIRTY' OR p.review_decision = 'CHANGES_REQUESTED' OR p.new_comments > 0 THEN 'needs_action'
    WHEN p.review_decision = 'APPROVED' OR p.raw ->> '$.autoMergeRequest.enabledAt' IS NOT NULL OR p.raw ->> '$.isInMergeQueue' THEN 'ready'
    ELSE 'awaiting_review'
  END AS status
FROM github.prs p
