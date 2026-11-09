-- Scopes the provider actually granted on the stored token, next to the
-- requested list in scopes_json. Null until the next connect records them.
ALTER TABLE user_integrations ADD COLUMN granted_scopes_json TEXT;
ALTER TABLE user_integrations ADD COLUMN granted_scopes_source TEXT
	CHECK (granted_scopes_source IN ('github-x-oauth-scopes', 'token-response'));
ALTER TABLE user_integrations ADD COLUMN granted_scopes_checked_at TEXT;
