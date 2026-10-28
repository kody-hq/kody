-- Per-automation execution-context setting set from the API, CLI or UI.
-- Overrides the `execution` an automation declares in its package manifest.
CREATE TABLE IF NOT EXISTS automation_execution_settings (
	org_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('job', 'webhook', 'subscription')),
	target_id TEXT NOT NULL,
	execution_json TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	updated_by_user_id TEXT NOT NULL,
	PRIMARY KEY (org_id, kind, target_id)
);
