-- Owner opt-in for filling a credential into the query, URL path, or body.
-- Placement enforcement honors those parts only when they are opted in here,
-- because the host may store the value. Headers need no opt-in.
CREATE TABLE credential_fill_placement_opt_ins (
	credential_id TEXT PRIMARY KEY NOT NULL,
	query INTEGER NOT NULL DEFAULT 0 CHECK (query IN (0, 1)),
	path INTEGER NOT NULL DEFAULT 0 CHECK (path IN (0, 1)),
	body INTEGER NOT NULL DEFAULT 0 CHECK (body IN (0, 1)),
	source TEXT NOT NULL CHECK (source IN ('owner', 'observed')),
	updated_at TEXT NOT NULL
);

-- Keep what already works: a part a credential was seen filled into before
-- enforcement counts as opted in, so nobody has to migrate anything by hand.
INSERT INTO credential_fill_placement_opt_ins (
	credential_id, query, path, body, source, updated_at
)
SELECT
	credential_id,
	json_extract(filled_last_seen_json, '$.query') IS NOT NULL,
	json_extract(filled_last_seen_json, '$.path') IS NOT NULL,
	json_extract(filled_last_seen_json, '$.body') IS NOT NULL,
	'observed',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM credential_fill_placement_observations
WHERE json_extract(filled_last_seen_json, '$.query') IS NOT NULL
	OR json_extract(filled_last_seen_json, '$.path') IS NOT NULL
	OR json_extract(filled_last_seen_json, '$.body') IS NOT NULL;
