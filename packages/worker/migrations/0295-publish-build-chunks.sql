-- One row per distinct chunk a publish build has stored. A chunk PUT inserts
-- its row only while the build is under maxBlobsPerBuild and maxUploadBytes,
-- so concurrent and retried uploads of one chunk count it once.
CREATE TABLE publish_build_chunks (
	build_id TEXT NOT NULL,
	sha256 TEXT NOT NULL,
	bytes INTEGER NOT NULL,
	PRIMARY KEY (build_id, sha256)
);
