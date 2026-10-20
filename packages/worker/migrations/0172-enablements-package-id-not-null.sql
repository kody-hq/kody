-- #3738: make enablements.package_id NOT NULL.
--
-- Two `off` audit tombstones left over from adminLegacyJobsRetire (2026-10-11)
-- still have package_id IS NULL and cannot be backfilled (legacy unattached
-- jobs, no package). Kent approved deleting them so the column can become
-- NOT NULL. SQLite cannot ALTER COLUMN, so this migration asserts, deletes
-- only the approved primary keys, asserts clean, then rebuilds the table.
--
-- Delete by the two known ids (not a broad NULL+off sweep) so unexpected
-- NULL tombstones fail closed instead of being silently removed. Indexes
-- include every enablements index from 0106, 0136, and 0138.

-- 1. Never delete a live enablement: abort if any NULL package_id is not off.
DROP TABLE IF EXISTS __migration_assertions;

CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'enablements.package_id IS NULL on a non-off row; aborting 0172 (refuses to delete a live enablement).'
WHERE EXISTS (
	SELECT 1 FROM enablements WHERE package_id IS NULL AND state <> 'off'
);

-- 2. Fail closed on unexpected NULL package_id rows (any state). Only the
-- two Kent-approved tombstone ids may be NULL before the delete.
INSERT INTO __migration_assertions (message)
SELECT 'enablements has unexpected package_id IS NULL rows beyond the two Kent-approved off tombstones; aborting 0172.'
WHERE EXISTS (
	SELECT 1 FROM enablements
	WHERE package_id IS NULL
		AND id NOT IN (
			'a572c222-bfbb-4dbd-a640-0ca53c8d86c3',
			'9ab4ec1f-275e-4d2c-a1ff-dce0300846a2'
		)
);

DROP TABLE __migration_assertions;

-- 3. Delete exactly the two approved tombstones by primary key. The
-- package_id IS NULL AND state = 'off' guards are defense in depth so a
-- reused id that somehow became live would not be deleted.
DELETE FROM enablements
WHERE id IN (
	'a572c222-bfbb-4dbd-a640-0ca53c8d86c3',
	'9ab4ec1f-275e-4d2c-a1ff-dce0300846a2'
)
AND package_id IS NULL
AND state = 'off';

-- 4. Fail closed if any NULL package_id remains (wrong env or missed row).
DROP TABLE IF EXISTS __migration_assertions;

CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'enablements.package_id IS NULL remains after deleting approved tombstones; aborting 0172.'
WHERE EXISTS (SELECT 1 FROM enablements WHERE package_id IS NULL);

DROP TABLE __migration_assertions;

-- 5. Rebuild with package_id TEXT NOT NULL. Preserve every column, CHECK,
-- and index from the current schema (0106 + 0110 paused_credential_id +
-- 0136 webhook one-live + 0138 sender columns/indexes).
CREATE TABLE enablements_next (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	trigger_kind TEXT NOT NULL CHECK (
		trigger_kind IN ('cron', 'subscription', 'webhook')
	),
	trigger_name TEXT NOT NULL,
	instance_id TEXT NOT NULL,
	enabler_user_id TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'on' CHECK (state IN ('on', 'paused', 'off')),
	paused_reason TEXT CHECK (
		paused_reason IS NULL
		OR paused_reason IN ('org_access', 'package_access', 'credential_access')
	),
	paused_permission TEXT,
	paused_resource_type TEXT,
	paused_resource_id TEXT,
	paused_credential_id TEXT,
	paused_at TEXT,
	credential_mapping_json TEXT,
	origin TEXT NOT NULL CHECK (origin IN ('enabled', 'migrated')),
	sender_kind TEXT CHECK (
		sender_kind IS NULL
		OR sender_kind IN ('member', 'address', 'domain', 'any_authenticated')
	),
	sender_value TEXT,
	enabled_at TEXT NOT NULL,
	disabled_at TEXT,
	updated_at TEXT NOT NULL
);

INSERT INTO enablements_next (
	id,
	org_id,
	package_id,
	trigger_kind,
	trigger_name,
	instance_id,
	enabler_user_id,
	state,
	paused_reason,
	paused_permission,
	paused_resource_type,
	paused_resource_id,
	paused_credential_id,
	paused_at,
	credential_mapping_json,
	origin,
	sender_kind,
	sender_value,
	enabled_at,
	disabled_at,
	updated_at
)
SELECT
	id,
	org_id,
	package_id,
	trigger_kind,
	trigger_name,
	instance_id,
	enabler_user_id,
	state,
	paused_reason,
	paused_permission,
	paused_resource_type,
	paused_resource_id,
	paused_credential_id,
	paused_at,
	credential_mapping_json,
	origin,
	sender_kind,
	sender_value,
	enabled_at,
	disabled_at,
	updated_at
FROM enablements;

DROP TABLE enablements;

ALTER TABLE enablements_next RENAME TO enablements;

CREATE INDEX enablements_instance
	ON enablements (org_id, trigger_kind, instance_id)
	WHERE state <> 'off';

CREATE INDEX enablements_enabler
	ON enablements (enabler_user_id, org_id)
	WHERE state <> 'off';

CREATE UNIQUE INDEX enablements_migrated_instance
	ON enablements (
		org_id,
		trigger_kind,
		instance_id,
		(CASE WHEN trigger_kind = 'subscription' THEN trigger_name ELSE '' END)
	)
	WHERE origin = 'migrated';

CREATE UNIQUE INDEX enablements_webhook_one_live
	ON enablements (org_id, instance_id)
	WHERE trigger_kind = 'webhook' AND state <> 'off';

CREATE INDEX enablements_subscription_sender
	ON enablements (org_id, instance_id, sender_kind, sender_value)
	WHERE state <> 'off' AND trigger_kind = 'subscription';

CREATE UNIQUE INDEX enablements_email_sender_one_live
	ON enablements (
		org_id,
		instance_id,
		trigger_name,
		sender_kind,
		IFNULL(sender_value, '')
	)
	WHERE state <> 'off'
		AND trigger_kind = 'subscription'
		AND trigger_name IN (
			'email.message.received',
			'email.message.quarantined'
		)
		AND sender_kind IS NOT NULL;
