-- Runtime readers (apps, modules, importable exports, subscriptions, jobs)
-- serve `serving_commit`: the last published commit whose every bundle
-- artifact target is saved. Publish moves `published_commit` first and only
-- compare-and-sets `serving_commit` once the new commit's targets are all
-- saved, so an in-flight or failed rebuild keeps the previous build serving.
ALTER TABLE entity_sources ADD COLUMN serving_commit TEXT;

-- Backfill: a package already serves its published commit when every stored
-- bundle artifact identity is at that commit. Packages with a lagging (or no)
-- artifact row stay NULL, which readers treat as `published_commit` until the
-- next complete rebuild sets the pointer.
UPDATE entity_sources
SET serving_commit = published_commit
WHERE entity_kind = 'package'
	AND published_commit IS NOT NULL
	AND deleted_at IS NULL
	AND EXISTS (
		SELECT 1 FROM published_bundle_artifacts a
		WHERE a.source_id = entity_sources.id
			AND a.user_id = entity_sources.user_id
			AND a.published_commit = entity_sources.published_commit
	)
	AND NOT EXISTS (
		SELECT 1 FROM published_bundle_artifacts a
		WHERE a.source_id = entity_sources.id
			AND a.user_id = entity_sources.user_id
			AND a.published_commit != entity_sources.published_commit
	);
