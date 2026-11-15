-- Refusal log: a call that did not come through a package-bound handle asked
-- for a user credential whose allowed_packages list is non-empty, and was
-- refused. One row per UTC day + owner + credential + kind + surface + pattern
-- + run package. `pattern` is the shared channel the call arrived on. `run_package_id` is '' when the run has no package. Never holds
-- credential values.
CREATE TABLE credential_unbound_use_refusals (
	day TEXT NOT NULL,
	owner_id TEXT NOT NULL,
	credential_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('ad_hoc', 'run_package_unbound')),
	surface TEXT NOT NULL CHECK (surface IN ('hosted', 'app')),
	pattern TEXT NOT NULL CHECK (pattern IN ('shared_fetch', 'shared_capability')),
	run_package_id TEXT NOT NULL DEFAULT '',
	credential_name TEXT NOT NULL,
	first_seen_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	observations INTEGER NOT NULL DEFAULT 0 CHECK (observations >= 0),
	PRIMARY KEY (day, owner_id, credential_id, kind, surface, pattern, run_package_id)
);

CREATE INDEX credential_unbound_use_refusals_owner_idx
	ON credential_unbound_use_refusals (owner_id, day);
