-- Package-app visitor attribution gains `visitor_profile_id`: the agent
-- profile that made a visit for the person (`appFetch`, or a browser session
-- opened with `appOpenLink`). Empty means the person visited themselves,
-- which is every existing row. The row stays under the same person
-- (`visitor_user_id`), so the publisher's Visitors view still counts one
-- visitor and can name the profiles that acted for them.
--
-- The column joins the primary key (a person and their profile can both
-- visit on the same day), and SQLite cannot alter a primary key, so this
-- rebuilds the table. The rows are derived (recomputed hourly from Analytics
-- Engine), so a straight copy is enough.
CREATE TABLE package_app_visitor_attribution_daily_next (
	user_id TEXT NOT NULL,
	day TEXT NOT NULL,
	package_id TEXT NOT NULL,
	visitor_user_id TEXT NOT NULL DEFAULT '',
	visitor_profile_id TEXT NOT NULL DEFAULT '',
	billed_org_id TEXT NOT NULL DEFAULT '',
	meter TEXT NOT NULL,
	units REAL NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (
		user_id, day, package_id, visitor_user_id, visitor_profile_id,
		billed_org_id, meter
	)
);

INSERT INTO package_app_visitor_attribution_daily_next (
	user_id, day, package_id, visitor_user_id, visitor_profile_id,
	billed_org_id, meter, units, updated_at
)
SELECT
	user_id, day, package_id, visitor_user_id, '', billed_org_id, meter, units,
	updated_at
FROM package_app_visitor_attribution_daily;

DROP TABLE package_app_visitor_attribution_daily;

ALTER TABLE package_app_visitor_attribution_daily_next
RENAME TO package_app_visitor_attribution_daily;

CREATE INDEX idx_package_app_visitor_attribution_user_package_day
ON package_app_visitor_attribution_daily(user_id, package_id, day);
