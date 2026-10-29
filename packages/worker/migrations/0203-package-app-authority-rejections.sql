-- Hard rejections for package apps that run as their publisher (ADR 0068
-- amendment 2026-10-24).
--
-- A bridge call refused because the capability is not listed in
-- `kody.app.capabilities` (including `credential.named`) that also failed
-- the legacy visitor way, so the app saw the error. Keyed like
-- package_app_authority_fallbacks (UTC day + app + call + kind of difference
-- + hashed visitor) so both logs read together. Never holds handles, names,
-- or values.
CREATE TABLE package_app_authority_rejections (
	day TEXT NOT NULL,
	owner_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	call_name TEXT NOT NULL,
	difference_kind TEXT NOT NULL,
	visitor_hash TEXT NOT NULL,
	first_seen_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	observations INTEGER NOT NULL DEFAULT 0 CHECK (observations >= 0),
	PRIMARY KEY (day, package_id, call_name, difference_kind, visitor_hash)
);

CREATE INDEX package_app_authority_rejections_package_idx
	ON package_app_authority_rejections (package_id, day);
