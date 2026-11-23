CREATE TABLE app_starters (
	package_id TEXT PRIMARY KEY NOT NULL REFERENCES saved_packages (id) ON DELETE CASCADE,
	rank INTEGER NOT NULL CHECK (typeof(rank) = 'integer' AND rank >= 1),
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	note TEXT CHECK (note IS NULL OR length(note) <= 500)
);

CREATE INDEX app_starters_enabled_rank ON app_starters (enabled, rank);
