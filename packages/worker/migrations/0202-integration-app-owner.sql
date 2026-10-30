-- ADR 0068 amendment 2026-10-29: a personal OAuth connection can be made
-- through another org's OAuth app and is then pinned to that org.
--
-- Adds user_integrations.app_owner_id: the org that owns the bring-your-own
-- app in (app_owner_id, app_slug). Every existing app_slug row is copied with
-- app_owner_id = user_id (same owner, unchanged meaning); platform rows keep
-- NULL. The same-owner foreign key (user_id, app_slug) becomes
-- (app_owner_id, app_slug), still ON DELETE RESTRICT, so deleting an org app
-- must wipe the personal connections pinned to it first (the delete paths do).
--
-- SQLite cannot change a foreign key in place, so the table is rebuilt with
-- every column in its existing order and app_owner_id appended. No table
-- references user_integrations, and its parents are not touched.
--
-- Deploy applies this before the new Worker ships. The old Worker inserts
-- without app_owner_id; user_integrations_default_app_owner fills it in.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE user_integrations_0202 (
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	app_slug TEXT,
	platform_app_slug TEXT REFERENCES platform_oauth_apps(slug) ON DELETE RESTRICT,
	account_label TEXT,
	description TEXT NOT NULL DEFAULT '',
	scopes_json TEXT NOT NULL DEFAULT '[]',
	required_hosts_json TEXT NOT NULL DEFAULT '[]',
	connected_at TEXT,
	token_refreshed_at TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	access_token_encrypted TEXT,
	refresh_token_encrypted TEXT,
	usage_mode TEXT NOT NULL DEFAULT 'any' CHECK (usage_mode IN ('any', 'packages')),
	allowed_packages_json TEXT NOT NULL DEFAULT '[]',
	auth_failed_at TEXT,
	auth_failed_reason TEXT,
	auth_failed_provider_error TEXT,
	auth_failed_provider_description TEXT,
	auth_failed_http_status INTEGER,
	auth_failed_reconnectable INTEGER CHECK (auth_failed_reconnectable IN (0, 1)),
	refresh_policy TEXT CHECK (refresh_policy IN ('required', 'not_applicable')),
	deleted_at TEXT,
	deleting_at TEXT,
	connected_by_user_id TEXT,
	token_refresh_lease_id TEXT,
	token_refresh_lease_expires_at TEXT,
	id TEXT,
	provider TEXT,
	inject_json TEXT NOT NULL
		DEFAULT '{"kind":"header","name":"Authorization","format":"Bearer {value}"}'
		CHECK (json_valid(inject_json)),
	source_json TEXT NOT NULL DEFAULT '"stored"' CHECK (json_valid(source_json)),
	placement_json TEXT CHECK (placement_json IS NULL OR json_valid(placement_json)),
	app_owner_id TEXT,
	PRIMARY KEY (user_id, name),
	FOREIGN KEY (app_owner_id, app_slug) REFERENCES user_oauth_apps(user_id, slug) ON DELETE RESTRICT,
	CHECK ((app_slug IS NULL) <> (platform_app_slug IS NULL))
);

INSERT INTO user_integrations_0202
SELECT *, CASE WHEN app_slug IS NOT NULL THEN user_id ELSE NULL END
FROM user_integrations;

DROP TABLE user_integrations;
ALTER TABLE user_integrations_0202 RENAME TO user_integrations;

CREATE INDEX idx_user_integrations_user_app_slug
ON user_integrations(user_id, app_slug);
CREATE INDEX idx_user_integrations_platform_app
ON user_integrations(platform_app_slug)
WHERE platform_app_slug IS NOT NULL;
CREATE UNIQUE INDEX user_integrations_id ON user_integrations (id);

-- Connections (own and members' pinned ones) per app.
CREATE INDEX idx_user_integrations_app_owner_slug
ON user_integrations(app_owner_id, app_slug)
WHERE app_owner_id IS NOT NULL;

-- One personal connection per person per org app.
CREATE UNIQUE INDEX user_integrations_pinned_app
ON user_integrations(app_owner_id, app_slug, user_id)
WHERE app_owner_id IS NOT NULL AND app_owner_id <> user_id;

CREATE TRIGGER user_integrations_assign_id
AFTER INSERT ON user_integrations
WHEN NEW.id IS NULL
BEGIN
	UPDATE user_integrations
	SET id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
		|| substr(lower(hex(randomblob(2))), 2) || '-'
		|| substr('89ab', 1 + (random() & 3), 1)
		|| substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
	WHERE rowid = NEW.rowid AND id IS NULL;
END;

CREATE TRIGGER user_integrations_default_app_owner
AFTER INSERT ON user_integrations
WHEN NEW.app_slug IS NOT NULL AND NEW.app_owner_id IS NULL
BEGIN
	UPDATE user_integrations SET app_owner_id = NEW.user_id
	WHERE rowid = NEW.rowid AND app_owner_id IS NULL;
END;

CREATE TRIGGER user_integrations_default_app_owner_on_update
AFTER UPDATE OF app_slug ON user_integrations
WHEN NEW.app_slug IS NOT NULL AND NEW.app_owner_id IS NULL
BEGIN
	UPDATE user_integrations SET app_owner_id = NEW.user_id
	WHERE rowid = NEW.rowid AND app_owner_id IS NULL;
END;
