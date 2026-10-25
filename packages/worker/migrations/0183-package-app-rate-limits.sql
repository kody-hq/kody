CREATE TABLE package_app_rate_limits (
	bucket_key TEXT PRIMARY KEY,
	window_start INTEGER NOT NULL,
	count INTEGER NOT NULL
);
