-- Credential attribution log. Never holds credential values. Two kinds of row:
-- a refusal ('ad_hoc', 'run_package_unbound', 'listed_package_unbound'), where a call that did not come
-- through a package-bound handle asked for a user credential whose
-- allowed_packages list is non-empty; and 'intrinsics_changed', where a listed
-- package used such a credential through its bound fetch in a run whose shared
-- globals had been replaced (allowed, recorded to measure the practice).
-- `pattern` is the channel the call arrived on. `run_package_id` is '' when
-- the run has no package. On 'listed_package_unbound' rows `bound_package_id`
-- is a listed package loaded in the run, whose bundle may predate request
-- binding. On 'intrinsics_changed' rows it is the package that made the
-- request, with `changed_intrinsics` as comma separated names.
CREATE TABLE credential_attribution_log (
	day TEXT NOT NULL,
	owner_id TEXT NOT NULL,
	credential_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('ad_hoc', 'run_package_unbound', 'listed_package_unbound', 'intrinsics_changed')),
	surface TEXT NOT NULL CHECK (surface IN ('hosted', 'app')),
	pattern TEXT NOT NULL CHECK (pattern IN ('shared_fetch', 'shared_capability', 'bound_fetch')),
	run_package_id TEXT NOT NULL DEFAULT '',
	bound_package_id TEXT NOT NULL DEFAULT '',
	changed_intrinsics TEXT NOT NULL DEFAULT '',
	credential_name TEXT NOT NULL,
	first_seen_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	observations INTEGER NOT NULL DEFAULT 0 CHECK (observations >= 0),
	PRIMARY KEY (day, owner_id, credential_id, kind, surface, pattern, run_package_id, bound_package_id, changed_intrinsics)
);

CREATE INDEX credential_attribution_log_owner_idx
	ON credential_attribution_log (owner_id, day);
