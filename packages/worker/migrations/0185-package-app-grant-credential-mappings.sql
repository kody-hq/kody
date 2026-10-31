CREATE TABLE package_app_grant_credential_mappings (
	grant_id TEXT NOT NULL,
	need_key TEXT NOT NULL,
	credential_ids_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (grant_id, need_key),
	FOREIGN KEY (grant_id) REFERENCES package_app_oauth_grants(id) ON DELETE CASCADE
);
