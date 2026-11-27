-- Session analytics (2026-11-27). Opt-in per org: every org starts 'unset' and
-- nothing is recorded until an Owner or Admin sets 'enabled'.
ALTER TABLE orgs ADD COLUMN session_analytics TEXT NOT NULL DEFAULT 'unset'
	CHECK (session_analytics IN ('unset', 'enabled', 'declined'));

-- Counters for a session that is still open. A row exists only so outcome and
-- stuck point can be counted across stateless requests. It is folded into
-- session_analytics_counts and deleted when the session closes.
CREATE TABLE session_analytics_open_sessions (
	session_id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	started_at TEXT NOT NULL,
	last_call_at TEXT NOT NULL,
	call_count INTEGER NOT NULL DEFAULT 0,
	error_count INTEGER NOT NULL DEFAULT 0,
	client_name TEXT NOT NULL DEFAULT 'unknown',
	surface TEXT NOT NULL CHECK (surface IN ('mcp', 'cli', 'api')),
	category_id TEXT,
	category_source TEXT NOT NULL DEFAULT 'none'
		CHECK (category_source IN ('memory_context', 'search_task', 'none')),
	search_task TEXT,
	streak_kind TEXT,
	streak_tool TEXT,
	streak_length INTEGER NOT NULL DEFAULT 0,
	max_streak INTEGER NOT NULL DEFAULT 0,
	max_streak_kind TEXT,
	max_streak_tool TEXT,
	recovered INTEGER NOT NULL DEFAULT 0 CHECK (recovered IN (0, 1)),
	nudged INTEGER NOT NULL DEFAULT 0 CHECK (nudged IN (0, 1)),
	last_call_failed INTEGER NOT NULL DEFAULT 0 CHECK (last_call_failed IN (0, 1)),
	package_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX session_analytics_open_sessions_org
	ON session_analytics_open_sessions (org_id);
CREATE INDEX session_analytics_open_sessions_last_call
	ON session_analytics_open_sessions (last_call_at);

-- How a later call finds its open session. Ids only, deleted with the session.
CREATE TABLE session_analytics_links (
	org_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	link_kind TEXT NOT NULL CHECK (link_kind IN ('conversation', 'object')),
	link_key TEXT NOT NULL,
	session_id TEXT NOT NULL,
	PRIMARY KEY (org_id, user_id, link_kind, link_key)
);
CREATE INDEX session_analytics_links_session
	ON session_analytics_links (session_id);

-- The only rows that persist: content-free counts, one row per org, member,
-- day, and outcome shape. Every insights view reads these.
CREATE TABLE session_analytics_counts (
	org_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	day TEXT NOT NULL,
	category_id TEXT NOT NULL DEFAULT '',
	outcome TEXT NOT NULL
		CHECK (outcome IN ('succeeded', 'recovered', 'stuck', 'abandoned', 'unknown')),
	stuck_kind TEXT NOT NULL DEFAULT '',
	stuck_tool TEXT NOT NULL DEFAULT '',
	client_name TEXT NOT NULL DEFAULT 'unknown',
	surface TEXT NOT NULL CHECK (surface IN ('mcp', 'cli', 'api')),
	sessions INTEGER NOT NULL DEFAULT 0,
	linked_sessions INTEGER NOT NULL DEFAULT 0,
	calls INTEGER NOT NULL DEFAULT 0,
	errors INTEGER NOT NULL DEFAULT 0,
	nudged_sessions INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (
		org_id, user_id, day, category_id, outcome, stuck_kind, stuck_tool,
		client_name, surface
	)
);
CREATE INDEX session_analytics_counts_day ON session_analytics_counts (day);

-- Emergent category registry. Names carry no user data by rule.
CREATE TABLE session_analytics_categories (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL DEFAULT 'active'
		CHECK (status IN ('active', 'merged', 'retired')),
	merged_into TEXT,
	created_at TEXT NOT NULL
);

-- Publisher analytics: sessions that called a public package, per org and day.
CREATE TABLE session_analytics_package_counts (
	package_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	day TEXT NOT NULL,
	outcome TEXT NOT NULL
		CHECK (outcome IN ('succeeded', 'recovered', 'stuck', 'abandoned', 'unknown')),
	stuck_kind TEXT NOT NULL DEFAULT '',
	sessions INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (package_id, org_id, user_id, day, outcome, stuck_kind)
);
CREATE INDEX session_analytics_package_counts_org
	ON session_analytics_package_counts (org_id);

-- Daily counters for the category name checks. No org, user, or name.
CREATE TABLE session_analytics_label_stats (
	day TEXT PRIMARY KEY,
	labeled INTEGER NOT NULL DEFAULT 0,
	reused INTEGER NOT NULL DEFAULT 0,
	proposed_passes INTEGER NOT NULL DEFAULT 0,
	proposals INTEGER NOT NULL DEFAULT 0,
	rejected_precheck INTEGER NOT NULL DEFAULT 0,
	rejected_judge INTEGER NOT NULL DEFAULT 0,
	accepted INTEGER NOT NULL DEFAULT 0,
	failed_three_attempts INTEGER NOT NULL DEFAULT 0,
	model_failed INTEGER NOT NULL DEFAULT 0
);

-- A stuck pattern Kody staff marked fixed on a date, for before and after.
CREATE TABLE session_analytics_fix_marks (
	category_id TEXT NOT NULL,
	stuck_kind TEXT NOT NULL,
	stuck_tool TEXT NOT NULL,
	fixed_on TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (category_id, stuck_kind, stuck_tool)
);
