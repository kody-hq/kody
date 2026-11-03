-- Every send from a reserved system sender (kody@ transactional mail and
-- operator correspondence) is recorded so Cloudflare delivery and bounce
-- reports can be matched to it. One row per recipient of a provider message.
CREATE TABLE system_email_sends (
	provider_message_id TEXT NOT NULL,
	recipient TEXT NOT NULL,
	sender TEXT NOT NULL,
	kind TEXT NOT NULL,
	sent_at TEXT NOT NULL,
	last_status TEXT,
	last_status_at TEXT,
	hard_bounced_at TEXT,
	PRIMARY KEY (provider_message_id, recipient)
);

CREATE INDEX idx_system_email_sends_sent_at ON system_email_sends(sent_at);

-- Per-recipient lookup for the latest delivery, so a late-arriving bounce
-- older than a later delivery does not count toward suppression.
CREATE INDEX idx_system_email_sends_recipient_status_at
	ON system_email_sends(recipient, last_status_at);

-- Per-recipient hard-bounce state for system mail. One verification or
-- password-reset hard bounce sets verification_suppressed_at (the rule that
-- email_verification_hard_bounces held). Repeated hard bounces of any system
-- mail set suppressed_at, which stops all system mail to the address. A
-- delivered event or an admin clear deletes the row.
CREATE TABLE email_recipient_suppressions (
	recipient TEXT PRIMARY KEY NOT NULL,
	hard_bounce_count INTEGER NOT NULL DEFAULT 0,
	suppressed_at TEXT,
	verification_suppressed_at TEXT,
	last_status TEXT NOT NULL,
	last_detail TEXT,
	last_hard_bounce_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX idx_email_recipient_suppressions_updated_at
	ON email_recipient_suppressions(updated_at);

INSERT INTO email_recipient_suppressions (
	recipient, hard_bounce_count, suppressed_at, verification_suppressed_at,
	last_status, last_detail, last_hard_bounce_at, created_at, updated_at
)
SELECT
	recipient, 1, NULL, suppressed_at,
	status, detail, suppressed_at, suppressed_at, updated_at
FROM email_verification_hard_bounces;

DROP TABLE email_verification_hard_bounces;
