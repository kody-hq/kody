-- Stop further verification mail to a recipient after a hard bounce.
-- Keyed by the normalized address so every account sharing that recipient is
-- covered. A later delivered event for the same recipient deletes the row.

CREATE TABLE email_verification_hard_bounces (
	recipient TEXT PRIMARY KEY NOT NULL,
	status TEXT NOT NULL,
	detail TEXT,
	suppressed_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
