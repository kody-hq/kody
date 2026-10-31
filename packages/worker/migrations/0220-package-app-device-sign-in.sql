-- Package-app visitors on limited browsers can sign in on another device
-- (ADR 0094). Those requests reuse `oauth_device_authorizations` with
-- `kind = 'package_app'`: `client_id` is the package app client
-- (`owner/leaf`), `resource` is the app's `redirect_uri`, and `request_json`
-- holds the rest of the authorize request (state, PKCE challenge, the
-- requesting browser's label, remember-me). `approved_scope` is what the
-- approver allowed on the consent screen. CLI rows keep `kind = 'cli'`.
ALTER TABLE oauth_device_authorizations
	ADD COLUMN kind TEXT NOT NULL DEFAULT 'cli'
	CHECK (kind IN ('cli', 'package_app'));
ALTER TABLE oauth_device_authorizations ADD COLUMN request_json TEXT;
ALTER TABLE oauth_device_authorizations ADD COLUMN approved_scope TEXT;
