-- Follow events no enabled package subscription handled, kept as a bounded
-- Recent updates list per follow. Rows are org-owned through follower_org_id
-- and follow_id; follow maintenance drops expired rows and rows whose follow
-- is gone. dedupe_key keeps a retried delivery to one row.

CREATE TABLE IF NOT EXISTS follow_recent_updates (
	id TEXT PRIMARY KEY NOT NULL,
	follower_org_id TEXT NOT NULL,
	follow_id TEXT NOT NULL,
	event TEXT NOT NULL CHECK (event IN ('published', 'pushed')),
	dedupe_key TEXT NOT NULL,
	detail_json TEXT NOT NULL,
	occurred_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	UNIQUE (follow_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS follow_recent_updates_org_idx
	ON follow_recent_updates (follower_org_id, occurred_at);

CREATE INDEX IF NOT EXISTS follow_recent_updates_follow_idx
	ON follow_recent_updates (follow_id, occurred_at);

CREATE INDEX IF NOT EXISTS follow_recent_updates_created_idx
	ON follow_recent_updates (created_at);
