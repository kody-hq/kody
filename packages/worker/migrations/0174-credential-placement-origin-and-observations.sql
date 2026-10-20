-- Track how a secret's fill placement was chosen, and durable observe-mode
-- records of which request parts were filled vs would have been blocked.
-- Enforcement still does not change; these columns/tables feed the credential
-- page and later auto-narrowing (steps 4–5).

ALTER TABLE secret_entries ADD COLUMN placement_origin TEXT
	CHECK (
		placement_origin IS NULL
		OR placement_origin IN (
			'manifest',
			'default_unread',
			'default_undeclared',
			'owner',
			'explicit'
		)
	);

-- Per credential: last-seen timestamps for parts that were filled and parts
-- that would have been refused under the stored placement. Part keys are
-- headers | query | path | body. Values are ISO timestamps.
CREATE TABLE credential_fill_placement_observations (
	credential_id TEXT PRIMARY KEY NOT NULL,
	filled_last_seen_json TEXT NOT NULL
		CHECK (json_valid(filled_last_seen_json)),
	would_block_last_seen_json TEXT NOT NULL
		CHECK (json_valid(would_block_last_seen_json)),
	updated_at TEXT NOT NULL
);
