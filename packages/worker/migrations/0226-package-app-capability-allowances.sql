-- Per-app-version capability allowances (ADR 0089 amendment 2026-10-31).
--
-- Before the visitor fallback is removed, a few published app versions call
-- capabilities their `kody.app.capabilities` does not list, and only work
-- because the call falls back to the visitor. Each row lets exactly one
-- published commit of one app keep calling one capability as its runs-as
-- person. A new publish has a new commit, so the allowance never carries
-- over; publish and `kody dev check` name what to add instead.
--
-- Seeded from the fallback telemetry (capability_not_declared rows), pinned to
-- each app's published commit at migration time. Never holds handles, names,
-- or values.
CREATE TABLE package_app_capability_allowances (
	package_id TEXT NOT NULL,
	published_commit TEXT NOT NULL,
	capability_name TEXT NOT NULL,
	source TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (package_id, published_commit, capability_name)
);

INSERT OR IGNORE INTO package_app_capability_allowances (
	package_id,
	published_commit,
	capability_name,
	source,
	created_at
)
SELECT DISTINCT
	f.package_id,
	s.published_commit,
	f.call_name,
	'authority-fallback',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM package_app_authority_fallbacks f
JOIN saved_packages p ON p.id = f.package_id
JOIN entity_sources s ON s.id = p.source_id
WHERE f.difference_kind = 'capability_not_declared'
	AND f.call_name != 'credential.named'
	AND f.call_name NOT LIKE '\_\_kody%' ESCAPE '\'
	AND s.published_commit IS NOT NULL
	AND s.published_commit != '';
