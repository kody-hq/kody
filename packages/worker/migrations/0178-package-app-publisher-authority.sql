-- Package apps run as the publisher (ADR 0068 amendment 2026-10-24).
--
-- One row per app package. `runs_as_person_id` is the explicit runs-as
-- person an owner chose; null means the publisher. `published_by_person_id`
-- is who last published the package. Both are person ids, checked live (not
-- deleted, not suspended, still a member of the owning org) on every use.
-- `publisher_unknown` is 1 after someone published without a known person
-- (an Artifacts push the reconcile job picked up); the app then runs the
-- legacy way until a known person publishes.
CREATE TABLE package_app_authority (
	package_id TEXT PRIMARY KEY NOT NULL,
	owner_id TEXT NOT NULL,
	runs_as_person_id TEXT,
	published_by_person_id TEXT,
	publisher_unknown INTEGER NOT NULL DEFAULT 0 CHECK (publisher_unknown IN (0, 1)),
	updated_at TEXT NOT NULL
);

CREATE INDEX package_app_authority_owner_idx
	ON package_app_authority (owner_id);

-- Would-break log for the legacy visitor-authority fallback. A visitor call
-- that failed under publisher authority but succeeded as the visitor (today's
-- behavior) adds one observation. One row per UTC day + app + call + kind of
-- difference + hashed visitor. Never holds handles, names, or values.
CREATE TABLE package_app_authority_fallbacks (
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

CREATE INDEX package_app_authority_fallbacks_package_idx
	ON package_app_authority_fallbacks (package_id, day);

-- When the app last used a Sign in with Kody grant (Connected apps page).
ALTER TABLE package_app_oauth_grants ADD COLUMN last_used_at TEXT;
