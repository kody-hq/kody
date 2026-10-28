CREATE TABLE package_app_cookie_warnings (
	package_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	cookie_name TEXT NOT NULL,
	reason TEXT NOT NULL CHECK (
		reason IN ('added_httponly', 'missing_httponly')
	),
	first_seen_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	PRIMARY KEY (package_id, cookie_name),
	FOREIGN KEY (package_id) REFERENCES saved_packages(id) ON DELETE CASCADE
);

CREATE INDEX package_app_cookie_warnings_package_last_seen_idx
	ON package_app_cookie_warnings (package_id, last_seen_at DESC);

CREATE INDEX package_app_cookie_warnings_owner_user_id_idx
	ON package_app_cookie_warnings (owner_user_id);
