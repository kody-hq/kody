-- Publish offload: one row per build made outside the worker (Kody CLI or an
-- execution context). The builder uploads content-addressed chunks to R2
-- with a per-build ticket (only its sha256 is stored here), seals the build
-- with its file and target manifest, and the publish then verifies the
-- upload against the pushed commit before any artifact is served.
CREATE TABLE publish_builds (
	id TEXT PRIMARY KEY,
	package_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	requester_user_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	commit_sha TEXT NOT NULL,
	origin TEXT NOT NULL,
	context_id TEXT,
	context_name TEXT,
	ticket_sha256 TEXT NOT NULL,
	status TEXT NOT NULL,
	document_json TEXT,
	message TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	committed_at TEXT
);

CREATE INDEX publish_builds_source_commit
	ON publish_builds (source_id, commit_sha, status);
