-- The unrestricted shell becomes a machine access entry on every context that
-- has host commands turned on, so its operator can limit it to listed
-- packages. The list starts empty, which keeps what runs today.
INSERT OR IGNORE INTO machine_capabilities (
	id, context_id, org_id, operator_user_id, kind, name, created_at, updated_at
)
SELECT
	'mcap_shell_' || id,
	id,
	org_id,
	operator_user_id,
	'shell',
	'shell',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM execution_contexts
WHERE revoked_at IS NULL
	AND json_extract(grant_json, '$.commands.enabled') = 1;
