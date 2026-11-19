-- The machine wide local network switch becomes the machine access entry `lan` / `*` on
-- every context whose egress allows the local network, so its operator can
-- limit it to listed packages. The list starts empty, which keeps what runs
-- today.
INSERT OR IGNORE INTO machine_capabilities (
	id, context_id, org_id, operator_user_id, kind, name, description, created_at, updated_at
)
SELECT
	'mcap_network_' || id,
	id,
	org_id,
	operator_user_id,
	'lan',
	'*',
	'Every address on the local network, for every run on the machine.',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM execution_contexts
WHERE revoked_at IS NULL
	AND json_extract(grant_json, '$.egress.mode') = 'public-and-lan';
