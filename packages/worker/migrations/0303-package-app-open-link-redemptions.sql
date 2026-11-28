-- Burned `appOpenLink` tokens (D1, not KV) so single use is atomic: only one
-- concurrent exchange inserts the token id; every other one is a replay.

CREATE TABLE package_app_open_link_redemptions (
	jti TEXT PRIMARY KEY NOT NULL,
	expires_at TEXT NOT NULL
);

CREATE INDEX package_app_open_link_redemptions_expires_at_idx
	ON package_app_open_link_redemptions (expires_at);
