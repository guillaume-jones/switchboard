INSERT INTO attention.errors_cleared (id, through) VALUES (1, :through)
ON CONFLICT (id) DO UPDATE SET through = max(through, excluded.through)
