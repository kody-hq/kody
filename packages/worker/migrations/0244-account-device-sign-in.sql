-- Kody's own full-account sign-in can be approved on another device (ADR
-- 0094, amended): `oauth_device_authorizations` rows with `kind = 'account'`.
-- `client_id` is the fixed `kody-account` marker, `resource` is the app
-- origin, and `request_json` holds the requesting browser's label, its
-- approximate location, and where to land after sign-in.
--
-- SQLite cannot change a CHECK constraint, so this copies the table into
-- oauth_device_authorizations_next with `kind` widened and swaps, the way
-- 0239 rebuilt teams. Ids, rows, columns, and indexes are unchanged. No table
-- references oauth_device_authorizations by foreign key.
--
-- An older Worker keeps working: it never writes `kind = 'account'`, and its
-- CLI and package-app queries filter by kind.
--
-- Fails closed (nothing applies) when the copy does not match the original
-- row for row.

DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

CREATE TABLE oauth_device_authorizations_next (
	id TEXT PRIMARY KEY NOT NULL,
	device_code_hash TEXT NOT NULL UNIQUE,
	user_code TEXT NOT NULL UNIQUE,
	client_id TEXT NOT NULL,
	scope TEXT NOT NULL,
	resource TEXT NOT NULL,
	requested_org_slug TEXT,
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
	interval_seconds INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	last_polled_at INTEGER,
	user_id TEXT,
	org_id TEXT,
	decided_at INTEGER,
	consumed_at INTEGER,
	kind TEXT NOT NULL DEFAULT 'cli'
		CHECK (kind IN ('cli', 'package_app', 'account')),
	request_json TEXT,
	approved_scope TEXT
);

INSERT INTO oauth_device_authorizations_next (
	id, device_code_hash, user_code, client_id, scope, resource,
	requested_org_slug, status, interval_seconds, created_at, expires_at,
	last_polled_at, user_id, org_id, decided_at, consumed_at, kind,
	request_json, approved_scope
)
SELECT id, device_code_hash, user_code, client_id, scope, resource,
	requested_org_slug, status, interval_seconds, created_at, expires_at,
	last_polled_at, user_id, org_id, decided_at, consumed_at, kind,
	request_json, approved_scope
FROM oauth_device_authorizations;

INSERT INTO __migration_assertions (message)
SELECT 'oauth_device_authorizations_next does not match; aborting 0244.'
WHERE EXISTS (
	SELECT id, device_code_hash, user_code, client_id, scope, resource,
		requested_org_slug, status, interval_seconds, created_at, expires_at,
		last_polled_at, user_id, org_id, decided_at, consumed_at, kind,
		request_json, approved_scope
	FROM oauth_device_authorizations
	EXCEPT
	SELECT id, device_code_hash, user_code, client_id, scope, resource,
		requested_org_slug, status, interval_seconds, created_at, expires_at,
		last_polled_at, user_id, org_id, decided_at, consumed_at, kind,
		request_json, approved_scope
	FROM oauth_device_authorizations_next
)
OR (SELECT COUNT(*) FROM oauth_device_authorizations)
	!= (SELECT COUNT(*) FROM oauth_device_authorizations_next);

DROP TABLE __migration_assertions;
DROP TABLE oauth_device_authorizations;
ALTER TABLE oauth_device_authorizations_next
	RENAME TO oauth_device_authorizations;

CREATE INDEX oauth_device_authorizations_expires_idx
	ON oauth_device_authorizations (expires_at);
CREATE INDEX oauth_device_authorizations_user_idx
	ON oauth_device_authorizations (user_id);
