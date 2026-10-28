-- Observe-mode record for issue #4129: a self-authored or adopted package used
-- a user credential whose allowed_packages list is non-empty and does not list
-- it. Access is still allowed today; these rows size the impact before
-- enforcement. One row per UTC day + owner + credential + package. Never holds
-- credential values.
CREATE TABLE credential_allowed_packages_would_block (
	day TEXT NOT NULL,
	owner_id TEXT NOT NULL,
	credential_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	access_kind TEXT NOT NULL
		CHECK (access_kind IN ('self_authored', 'adopted')),
	first_seen_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	observations INTEGER NOT NULL DEFAULT 0 CHECK (observations >= 0),
	PRIMARY KEY (day, owner_id, credential_id, package_id)
);

CREATE INDEX credential_allowed_packages_would_block_owner_idx
	ON credential_allowed_packages_would_block (owner_id, day);
