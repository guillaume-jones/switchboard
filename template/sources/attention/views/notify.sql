SELECT id, ref, coalesce(title, ref) AS title, reason, level, woken_at FROM attention_open WHERE level >= 2
