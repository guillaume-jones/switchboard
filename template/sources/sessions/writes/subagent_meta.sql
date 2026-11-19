INSERT INTO sessions.subagents (id, session, description, agent_type, background)
SELECT :payload ->> '$.id', :payload ->> '$.session', :payload ->> '$.description', :payload ->> '$.agentType',
  :payload ->> '$.requestShape' = 'background'
WHERE :payload ->> '$.session' IN (SELECT session FROM sessions.transcripts)
ON CONFLICT (id) DO UPDATE SET
  description = excluded.description, agent_type = excluded.agent_type, background = excluded.background
