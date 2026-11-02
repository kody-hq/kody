-- Weekly paced D1 restore drill progress (one row per drilled UTC day plus one
-- row per source). The drill resumes from these rows across cron ticks and
-- `/__maintenance/dr-paced-status` reads them, so results are visible without
-- opening the R2 report.
CREATE TABLE IF NOT EXISTS dr_paced_restore_drill_runs (
	day TEXT PRIMARY KEY NOT NULL,
	status TEXT NOT NULL,
	lease_token TEXT,
	lease_until INTEGER,
	sources_total INTEGER NOT NULL DEFAULT 0,
	sources_ok INTEGER NOT NULL DEFAULT 0,
	report_key TEXT,
	error TEXT,
	started_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	finished_at TEXT
);

CREATE TABLE IF NOT EXISTS dr_paced_restore_drill_sources (
	day TEXT NOT NULL,
	database_id TEXT NOT NULL,
	database_name TEXT NOT NULL,
	status TEXT NOT NULL,
	active_table TEXT,
	active_phase TEXT,
	interrupted_count INTEGER NOT NULL DEFAULT 0,
	last_interrupted_table TEXT,
	tables_json TEXT NOT NULL DEFAULT '[]',
	result_json TEXT,
	error TEXT,
	started_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	finished_at TEXT,
	PRIMARY KEY (day, database_id)
);
