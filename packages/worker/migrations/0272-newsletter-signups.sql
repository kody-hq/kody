-- Public What's New in Kody sign-ups from /newsletter, for addresses that may
-- not have a Kody account. A row is only a recipient once status is
-- 'confirmed' (double opt-in); 'pending' rows have never confirmed.
CREATE TABLE newsletter_signups (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	-- Random 64 hex id, the same shape as users.stable_user_id, so newsletter
	-- tooling can address account and account-less recipients the same way.
	stable_id TEXT NOT NULL UNIQUE CHECK (length(stable_id) = 64),
	email TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
	source TEXT NOT NULL DEFAULT 'newsletter_page'
		CHECK (source IN ('newsletter_page', 'email_link', 'admin')),
	token_hash TEXT,
	token_expires_at INTEGER,
	requested_at TEXT NOT NULL,
	confirmed_at TEXT,
	updated_at TEXT NOT NULL
);

CREATE INDEX idx_newsletter_signups_token_hash
	ON newsletter_signups(token_hash);
