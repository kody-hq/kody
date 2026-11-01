-- Whether an org gets usage warnings (2026-10-31): the 80% and 100% usage
-- emails and the once-a-month heads-up on hosted execute responses. On by
-- default, so existing orgs keep today's behavior.
ALTER TABLE orgs ADD COLUMN usage_warnings_enabled INTEGER NOT NULL DEFAULT 1
	CHECK (usage_warnings_enabled IN (0, 1));
