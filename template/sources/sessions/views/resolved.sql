SELECT a.id, a.ref
FROM attention_items a
WHERE a.state != 'cleared' AND a.ref LIKE 'sessions:%'
  AND NOT EXISTS (
    SELECT 1 FROM sessions.items s
    WHERE 'sessions:' || s.id = a.ref AND s.status IN ('needs_permission', 'needs_input') AND s.decision IS NOT NULL AND s.answer IS NULL
  )
