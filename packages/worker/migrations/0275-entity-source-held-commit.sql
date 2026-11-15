-- A published commit whose build is complete but that does not serve yet
-- because it asks for more capabilities than its internet-visible app's owner
-- approved. Everyone, members included, stays on serving_commit (the last
-- approved commit that served) until the owner approves held_commit, which
-- then starts serving it. NULL when nothing is held.
ALTER TABLE entity_sources ADD COLUMN held_commit TEXT;

-- Apps already split (members on an unapproved serving commit, anonymous
-- visitors on the last approved commit that served) move everyone back to
-- the approved commit and hold the unapproved one. A newer publish that is
-- still building decides for itself once its build completes.
UPDATE entity_sources
SET held_commit = CASE
		WHEN serving_commit = published_commit THEN published_commit
		ELSE NULL
	END,
	serving_commit = (
		SELECT approval.published_commit
		FROM package_capability_approvals AS approval
		JOIN saved_packages AS package ON package.id = approval.package_id
		WHERE package.source_id = entity_sources.id
			AND package.deleted_at IS NULL
			AND approval.owner_user_id = entity_sources.user_id
			AND approval.served_at IS NOT NULL
		ORDER BY approval.served_at DESC, approval.approved_at DESC
		LIMIT 1
	),
	updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE deleted_at IS NULL
	AND entity_kind = 'package'
	AND serving_commit IS NOT NULL
	AND EXISTS (
		SELECT 1 FROM saved_packages AS package
		JOIN package_capability_approvals AS approval
			ON approval.package_id = package.id
			AND approval.owner_user_id = entity_sources.user_id
			AND approval.served_at IS NOT NULL
		WHERE package.source_id = entity_sources.id
			AND package.deleted_at IS NULL
			AND package.has_app = 1
			AND package.is_internet_visible = 1
	)
	AND NOT EXISTS (
		SELECT 1 FROM saved_packages AS package
		JOIN package_capability_approvals AS approval
			ON approval.package_id = package.id
			AND approval.owner_user_id = entity_sources.user_id
		WHERE package.source_id = entity_sources.id
			AND package.deleted_at IS NULL
			AND approval.published_commit = entity_sources.serving_commit
	);
