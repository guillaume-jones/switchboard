SELECT p.id, p.url, p.repo, p.number, p.title, p.ci, p.merge_state, p.auto_merge, p.queued, p.new_comments, p.folder, p.status, p.is_open, p.created_at
FROM workstreams_project_links pl
JOIN github_prs p ON p.url = pl.ref
WHERE pl.project = :project AND pl.kind = 'pr'
ORDER BY p.is_open DESC, coalesce(p.closed_at, p.created_at) DESC
