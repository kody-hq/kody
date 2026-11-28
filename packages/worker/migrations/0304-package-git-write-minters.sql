-- packageGetGitRemote write tokens push straight to Artifacts, so the Kody
-- git proxy never sees who pushed. Each mint notes its person until the token
-- expires, so the five-minute reconcile can publish that push as them.
CREATE TABLE package_git_write_minters (
	package_id TEXT NOT NULL,
	owner_id TEXT NOT NULL,
	person_id TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	PRIMARY KEY (package_id, person_id)
);
