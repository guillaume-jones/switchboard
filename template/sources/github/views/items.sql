SELECT id, url, repo, number, title, ci, merge_state, auto_merge, queued, new_comments, folder, created_at, closed_at, status, is_open,
  (SELECT min(pl.project) FROM workstreams_project_links pl WHERE pl.ref = github_prs.url) AS project
FROM github_prs
WHERE is_open OR closed_at > (unixepoch() - 14 * 86400) * 1000
ORDER BY is_open DESC, coalesce(closed_at, created_at) DESC
