-- Retire permissions that gated nothing (kody-hq/kody#3739).
--
-- 1. `job:create`, `app:create`, and `email:create` leave the registry. Jobs
--    and apps come from the package manifest (`package:create` /
--    `package:publish`) and inboxes are made at signup. Strip them from every
--    stored scope or permission list so strict readers never see them.
-- 2. `app:write` and `app:delete` leave the app Contribute/Manage presets and
--    the org-wide "Every package app" option. Package app changes and deletes
--    are `package:write` / `package:delete`. Strip them from org grants and
--    from preset app grants; advanced app grants keep them.
--
-- No surface checked any of these, so no one's effective access changes.
-- Idempotent: rows without them are left unchanged.

DROP TABLE IF EXISTS __retired_permissions;
CREATE TABLE __retired_permissions (perm TEXT NOT NULL PRIMARY KEY);
INSERT INTO __retired_permissions (perm) VALUES
	('app:create'),
	('email:create'),
	('job:create');

UPDATE api_tokens
SET scopes_json = (
	SELECT json_group_array(value)
	FROM (
		SELECT j.value AS value
		FROM json_each(api_tokens.scopes_json) AS j
		WHERE j.value NOT IN (SELECT perm FROM __retired_permissions)
		ORDER BY j.value
	)
)
WHERE EXISTS (
	SELECT 1
	FROM json_each(api_tokens.scopes_json) AS j
	WHERE j.value IN (SELECT perm FROM __retired_permissions)
);

UPDATE cli_credential_bootstrap_codes
SET scopes_json = (
	SELECT json_group_array(value)
	FROM (
		SELECT j.value AS value
		FROM json_each(cli_credential_bootstrap_codes.scopes_json) AS j
		WHERE j.value NOT IN (SELECT perm FROM __retired_permissions)
		ORDER BY j.value
	)
)
WHERE EXISTS (
	SELECT 1
	FROM json_each(cli_credential_bootstrap_codes.scopes_json) AS j
	WHERE j.value IN (SELECT perm FROM __retired_permissions)
);

UPDATE enablements
SET enabler_scopes_json = (
	SELECT json_group_array(value)
	FROM (
		SELECT j.value AS value
		FROM json_each(enablements.enabler_scopes_json) AS j
		WHERE j.value NOT IN (SELECT perm FROM __retired_permissions)
		ORDER BY j.value
	)
)
WHERE enabler_scopes_json IS NOT NULL
AND json_valid(enabler_scopes_json)
AND json_type(enabler_scopes_json) = 'array'
AND EXISTS (
	SELECT 1
	FROM json_each(enablements.enabler_scopes_json) AS j
	WHERE j.value IN (SELECT perm FROM __retired_permissions)
);

-- Invite lists keep their order; org invites also drop the app pair.
UPDATE invites
SET permissions_json = (
	SELECT json_group_array(j.value)
	FROM json_each(invites.permissions_json) AS j
	WHERE j.value NOT IN (SELECT perm FROM __retired_permissions)
	AND NOT (
		invites.resource_type = 'org'
		AND j.value IN ('app:write', 'app:delete')
	)
)
WHERE permissions_json IS NOT NULL
AND json_valid(permissions_json)
AND EXISTS (
	SELECT 1
	FROM json_each(invites.permissions_json) AS j
	WHERE j.value IN (SELECT perm FROM __retired_permissions)
	OR (
		invites.resource_type = 'org'
		AND j.value IN ('app:write', 'app:delete')
	)
);

DELETE FROM grant_permissions
WHERE permission IN (SELECT perm FROM __retired_permissions);

DELETE FROM grant_permissions
WHERE permission IN ('app:write', 'app:delete')
AND grant_id IN (
	SELECT id
	FROM grants
	WHERE resource_type = 'org'
	OR (resource_type = 'app' AND preset IS NOT NULL)
);

DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'api_tokens still carry a retired permission after 0239; aborting.'
WHERE EXISTS (
	SELECT 1
	FROM api_tokens AS t, json_each(t.scopes_json) AS j
	WHERE j.value IN (SELECT perm FROM __retired_permissions)
);

INSERT INTO __migration_assertions (message)
SELECT 'grant_permissions still carry a retired permission after 0239; aborting.'
WHERE EXISTS (
	SELECT 1
	FROM grant_permissions
	WHERE permission IN (SELECT perm FROM __retired_permissions)
);

DROP TABLE __migration_assertions;
DROP TABLE __retired_permissions;
