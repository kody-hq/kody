CREATE TABLE file_storage_default_quota (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	included_bytes INTEGER NOT NULL CHECK (included_bytes BETWEEN 0 AND 9007199254740991)
);

CREATE TABLE file_storage_quota_overrides (
	org_id TEXT PRIMARY KEY NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
	included_bytes INTEGER NOT NULL CHECK (included_bytes BETWEEN 0 AND 9007199254740991)
);
