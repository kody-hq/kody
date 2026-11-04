-- Retire `job:delete` (kody-hq/kody#3678).
--
-- No surface has checked `job:delete` since job deletion moved to the package
-- (#3422): a package's jobs go away with `package:write` / `package:delete`.
-- It leaves the registry and the job Manage preset. Strip it from every
-- stored scope or permission list so strict readers never see it; readers
-- also drop it (`withoutRetiredOrgPermissions`).
--
-- No surface checked it, so no one's effective access changes.
-- Idempotent: rows without it are left unchanged.

DROP TABLE IF EXISTS __retired_permissions;
CREATE TABLE __retired_permissions (perm TEXT NOT NULL PRIMARY KEY);
INSERT INTO __retired_permissions (perm) VALUES ('job:delete');

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

-- Invite lists keep their order.
UPDATE invites
SET permissions_json = (
	SELECT json_group_array(j.value)
	FROM json_each(invites.permissions_json) AS j
	WHERE j.value NOT IN (SELECT perm FROM __retired_permissions)
)
WHERE permissions_json IS NOT NULL
AND json_valid(permissions_json)
AND EXISTS (
	SELECT 1
	FROM json_each(invites.permissions_json) AS j
	WHERE j.value IN (SELECT perm FROM __retired_permissions)
);

DELETE FROM grant_permissions
WHERE permission IN (SELECT perm FROM __retired_permissions);


DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'api_tokens still carry a retired permission after 0251; aborting.'
WHERE EXISTS (
	SELECT 1
	FROM api_tokens AS t, json_each(t.scopes_json) AS j
	WHERE j.value IN (SELECT perm FROM __retired_permissions)
);

INSERT INTO __migration_assertions (message)
SELECT 'grant_permissions still carry a retired permission after 0251; aborting.'
WHERE EXISTS (
	SELECT 1
	FROM grant_permissions
	WHERE permission IN (SELECT perm FROM __retired_permissions)
);

DROP TABLE __migration_assertions;
DROP TABLE __retired_permissions;
