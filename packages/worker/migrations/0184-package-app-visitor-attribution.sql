CREATE TABLE package_app_visitor_attribution_daily (
	user_id TEXT NOT NULL,
	day TEXT NOT NULL,
	package_id TEXT NOT NULL,
	visitor_user_id TEXT NOT NULL DEFAULT '',
	meter TEXT NOT NULL,
	units REAL NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (user_id, day, package_id, visitor_user_id, meter)
);

CREATE INDEX idx_package_app_visitor_attribution_user_package_day
ON package_app_visitor_attribution_daily(user_id, package_id, day);
