-- Move disabled live webhook endpoints into enablement state before the Worker
-- stops reading webhook_endpoints.enabled. Orgs without a live Owner cannot
-- receive migrated tombstones and are left without a synthetic enabler.

UPDATE enablements
SET state = 'off',
	disabled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE trigger_kind = 'webhook'
	AND state <> 'off'
	AND EXISTS (
		SELECT 1
		FROM webhook_endpoints e
		WHERE e.id = enablements.instance_id
			AND e.user_id = enablements.org_id
			AND e.deleted_at IS NULL
			AND e.enabled = 0
	);

WITH live_disabled_endpoints AS (
	SELECT
		e.*,
		(
			SELECT m.user_id
			FROM org_memberships m
			INNER JOIN users u ON u.stable_user_id = m.user_id
			WHERE m.org_id = e.user_id
				AND m.role = 'owner'
				AND m.deleted_at IS NULL
				AND u.deleted_at IS NULL
				AND u.deleting_at IS NULL
				AND u.suspended_at IS NULL
			ORDER BY m.created_at, m.user_id
			LIMIT 1
		) AS owner_user_id
	FROM webhook_endpoints e
	WHERE e.deleted_at IS NULL
		AND e.enabled = 0
)
INSERT INTO enablements (
	id,
	org_id,
	package_id,
	trigger_kind,
	trigger_name,
	instance_id,
	enabler_user_id,
	state,
	origin,
	enabled_at,
	disabled_at,
	updated_at
)
SELECT
	'migrated-webhook-off-' || e.id,
	e.user_id,
	e.package_id,
	'webhook',
	e.webhook_name,
	e.id,
	e.owner_user_id,
	'off',
	'migrated',
	e.created_at,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM live_disabled_endpoints e
WHERE e.owner_user_id IS NOT NULL
	AND NOT EXISTS (
		SELECT 1
		FROM enablements existing
		WHERE existing.org_id = e.user_id
			AND existing.trigger_kind = 'webhook'
			AND existing.instance_id = e.id
	);
