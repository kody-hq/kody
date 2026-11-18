-- A sealed publish build document now lives in R2 (REPO_SESSION_BLOBS,
-- publish-build-documents/{buildId}/{sha256}.json) and the row keeps only its
-- sha256. Large packages sealed documents over D1's 100 KB import statement
-- limit, which made the nightly APP_DB export unrestorable (Nov 17-18, 2026).
-- Dropping document_json also clears those oversized values. Rows that still
-- had a document get an empty document_sha256 so purgeExpiredPublishBuilds
-- still deletes their R2 chunks; an empty hash reads as no document.
ALTER TABLE publish_builds ADD COLUMN document_sha256 TEXT;
UPDATE publish_builds SET document_sha256 = '' WHERE document_json IS NOT NULL;
ALTER TABLE publish_builds DROP COLUMN document_json;
