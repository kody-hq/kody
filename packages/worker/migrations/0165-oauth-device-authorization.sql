-- RFC 8628 device authorization grant for integrations (#3812).
-- Additive: optional device_authorization_url on user and platform OAuth apps,
-- plus flow='device'. Existing pkce/confidential rows are unchanged.
--
-- SQLite cannot ALTER CHECK constraints, so both oauth-app tables are rebuilt.
-- user_integrations FKs reference both parents (RESTRICT). D1 applies each
-- migration file as one remote batch with foreign keys enforced at commit, so
-- PRAGMA defer_foreign_keys alone is not enough when those child rows exist:
-- snapshot and clear user_integrations first (0002-style), rebuild parents,
-- then restore. Production apply of the first 0165 revision failed with
-- SQLITE_CONSTRAINT_FOREIGNKEY and rolled back before d1_migrations recorded
-- the file (#3980 deploy).

PRAGMA defer_foreign_keys = ON;

CREATE TABLE _mig0165_user_integrations AS SELECT * FROM user_integrations;
DELETE FROM user_integrations;

CREATE TABLE user_oauth_apps_0165 (
	user_id TEXT NOT NULL,
	slug TEXT NOT NULL,
	provider TEXT NOT NULL,
	label TEXT,
	client_id TEXT NOT NULL,
	client_secret_encrypted TEXT,
	token_url TEXT NOT NULL,
	authorize_url TEXT,
	device_authorization_url TEXT,
	api_base_url TEXT,
	flow TEXT NOT NULL CHECK (flow IN ('pkce', 'confidential', 'device')),
	use_pkce INTEGER CHECK (use_pkce IN (0, 1)),
	token_exchange_style TEXT CHECK (token_exchange_style IN ('form', 'basic-json', 'basic-form')),
	scope_separator TEXT,
	extra_authorize_params_json TEXT NOT NULL DEFAULT '{}',
	logo_key TEXT,
	logo_content_type TEXT,
	logo_source TEXT CHECK (logo_source IN ('upload', 'favicon')),
	favicon_source_host TEXT,
	deleted_at TEXT,
	deleting_at TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	PRIMARY KEY (user_id, slug)
);

INSERT INTO user_oauth_apps_0165 (
	user_id, slug, provider, label, client_id, client_secret_encrypted,
	token_url, authorize_url, device_authorization_url, api_base_url, flow,
	use_pkce, token_exchange_style, scope_separator, extra_authorize_params_json,
	logo_key, logo_content_type, logo_source, favicon_source_host,
	deleted_at, deleting_at, created_at, updated_at
)
SELECT
	user_id, slug, provider, label, client_id, client_secret_encrypted,
	token_url, authorize_url, NULL, api_base_url, flow,
	use_pkce, token_exchange_style, scope_separator, extra_authorize_params_json,
	logo_key, logo_content_type, logo_source, favicon_source_host,
	deleted_at, deleting_at, created_at, updated_at
FROM user_oauth_apps;

DROP TABLE user_oauth_apps;
ALTER TABLE user_oauth_apps_0165 RENAME TO user_oauth_apps;

CREATE INDEX idx_user_oauth_apps_user_provider
ON user_oauth_apps(user_id, provider);

CREATE TABLE platform_oauth_apps_0165 (
	slug TEXT PRIMARY KEY NOT NULL,
	provider TEXT NOT NULL,
	label TEXT,
	description TEXT,
	client_id TEXT NOT NULL,
	client_secret_encrypted TEXT,
	token_url TEXT NOT NULL,
	authorize_url TEXT NOT NULL,
	device_authorization_url TEXT,
	api_base_url TEXT,
	flow TEXT NOT NULL CHECK (flow IN ('pkce', 'confidential', 'device')),
	use_pkce INTEGER CHECK (use_pkce IN (0, 1)),
	token_exchange_style TEXT CHECK (token_exchange_style IN ('form', 'basic-json', 'basic-form')),
	scope_separator TEXT,
	extra_authorize_params_json TEXT NOT NULL DEFAULT '{}',
	allowed_scopes_json TEXT NOT NULL DEFAULT '[]',
	default_scopes_json TEXT NOT NULL DEFAULT '[]',
	required_hosts_json TEXT NOT NULL DEFAULT '[]',
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	visibility TEXT NOT NULL DEFAULT 'draft'
		CHECK (visibility IN ('draft', 'published')),
	logo_key TEXT,
	logo_content_type TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

INSERT INTO platform_oauth_apps_0165 (
	slug, provider, label, description, client_id, client_secret_encrypted,
	token_url, authorize_url, device_authorization_url, api_base_url, flow,
	use_pkce, token_exchange_style, scope_separator, extra_authorize_params_json,
	allowed_scopes_json, default_scopes_json, required_hosts_json, enabled,
	visibility, logo_key, logo_content_type, created_at, updated_at
)
SELECT
	slug, provider, label, description, client_id, client_secret_encrypted,
	token_url, authorize_url, NULL, api_base_url, flow,
	use_pkce, token_exchange_style, scope_separator, extra_authorize_params_json,
	allowed_scopes_json, default_scopes_json, required_hosts_json, enabled,
	visibility, logo_key, logo_content_type, created_at, updated_at
FROM platform_oauth_apps;

DROP TABLE platform_oauth_apps;
ALTER TABLE platform_oauth_apps_0165 RENAME TO platform_oauth_apps;

INSERT INTO user_integrations SELECT * FROM _mig0165_user_integrations;
DROP TABLE _mig0165_user_integrations;
