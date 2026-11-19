CREATE TABLE package_app_run_consents (
	person_id TEXT NOT NULL,
	package_id TEXT NOT NULL REFERENCES saved_packages(id) ON DELETE CASCADE,
	approved_at TEXT NOT NULL,
	PRIMARY KEY (person_id, package_id)
);

CREATE INDEX package_app_run_consents_package_idx
	ON package_app_run_consents (package_id);
