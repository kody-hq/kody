-- Any-host secretJwtSign callers until send_to_host is required (2026-12-02,
-- kody-hq/kody#4456). `user_id` is the owner org; `package_id` is '' for
-- execute code outside a package.
--
-- One row per caller pair that made an any-host call: `grandfathered` = 1
-- when Analytics Engine had seen the pair making any-host calls before new
-- callers were refused, 0 when it had not (re-checked after `checked_at`).
CREATE TABLE IF NOT EXISTS jwt_sign_any_host_callers (
	user_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	grandfathered INTEGER NOT NULL CHECK (grandfathered IN (0, 1)),
	checked_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, package_id)
);

-- Hosts an any-host sealed JWT was filled on, counted per caller pair. Never
-- holds the JWT. A pair with one destination domain gets send_to_host filled
-- in server-side once it is required.
CREATE TABLE IF NOT EXISTS jwt_sign_any_host_destinations (
	user_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	host TEXT NOT NULL,
	fill_count INTEGER NOT NULL DEFAULT 0,
	first_filled_at INTEGER NOT NULL,
	last_filled_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, package_id, host)
);
