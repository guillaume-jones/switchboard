INSERT INTO term.token (id, value) VALUES (1, :value) ON CONFLICT (id) DO UPDATE SET value = excluded.value
