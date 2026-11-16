-- A publish that outlives the request finishes in a durable workflow that
-- acts as the owning org, not as a person. The request notes who asked for
-- which commit here, so the finish step can record that person as publisher
-- once the commit is actually published (#5315). One row per commit, so
-- overlapping publishes of one package keep their own requester.
CREATE TABLE package_app_publish_requests (
	package_id TEXT NOT NULL,
	commit_sha TEXT NOT NULL,
	owner_id TEXT NOT NULL,
	person_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (package_id, commit_sha)
);
