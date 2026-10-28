-- Per-org feature flag rows: turn a flag on or off for a whole organization in
-- one audited row. Keyed by orgs.id (stable across slug renames). Operator
-- configuration, not user content. No foreign keys, matching the repo rows:
-- table rebuilds of orgs must not cascade-delete operator rollout state, and a
-- row for a deleted org never matches because evaluation requires a live
-- membership (or a live repo owned by the org).
CREATE TABLE feature_flag_org_overrides (
	flag_key TEXT NOT NULL,
	org_id TEXT NOT NULL,
	enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
	note TEXT NOT NULL DEFAULT '',
	updated_by TEXT,
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (flag_key, org_id)
);

CREATE INDEX feature_flag_org_overrides_org_id
	ON feature_flag_org_overrides (org_id);
