SELECT u.raw ->> '$.percent' AS percent, u.raw ->> '$.resets' AS resets, u.fetched_at
FROM claude.usage AS u
