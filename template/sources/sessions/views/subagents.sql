SELECT id, session, description, agent_type, coalesce(background, 1) AS background, activity, started_at, updated_at,
  coalesce(done, 0) AS done
FROM sessions.subagents
