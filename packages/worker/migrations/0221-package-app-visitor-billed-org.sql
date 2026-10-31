-- Package-app visitor attribution gains `billed_org_id` (ADR 0095). A visit
-- from another org to an internal app bills that visiting org for its
-- metered work, but the row stays under the app's owning org (`user_id`) so
-- the publisher's Visitors view keeps every visitor. Empty means the owning
-- org paid, which is every existing row.
--
-- The column joins the primary key (a visitor can be billed to the owner and
-- to their own org on the same day, for example after joining the org), and
-- SQLite cannot alter a primary key, so this rebuilds the table. The rows are
-- derived (recomputed hourly from Analytics Engine), so a straight copy is
-- enough.
CREATE TABLE package_app_visitor_attribution_daily_next (
	user_id TEXT NOT NULL,
	day TEXT NOT NULL,
	package_id TEXT NOT NULL,
	visitor_user_id TEXT NOT NULL DEFAULT '',
	billed_org_id TEXT NOT NULL DEFAULT '',
	meter TEXT NOT NULL,
	units REAL NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (
		user_id, day, package_id, visitor_user_id, billed_org_id, meter
	)
);

INSERT INTO package_app_visitor_attribution_daily_next (
	user_id, day, package_id, visitor_user_id, billed_org_id, meter, units,
	updated_at
)
SELECT
	user_id, day, package_id, visitor_user_id, '', meter, units, updated_at
FROM package_app_visitor_attribution_daily;

DROP TABLE package_app_visitor_attribution_daily;

ALTER TABLE package_app_visitor_attribution_daily_next
RENAME TO package_app_visitor_attribution_daily;

CREATE INDEX idx_package_app_visitor_attribution_user_package_day
ON package_app_visitor_attribution_daily(user_id, package_id, day);
