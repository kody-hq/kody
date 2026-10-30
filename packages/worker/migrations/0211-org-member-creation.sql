-- Whether team-org Members can create (2026-10-30). Owners always can.
-- `members_can_create_packages` gives Members package:create and app:create;
-- off keeps today's behavior (an Owner grants it). `members_can_create_credentials`
-- gives Members secret:create and integration:create; on by default.
ALTER TABLE orgs ADD COLUMN members_can_create_packages INTEGER NOT NULL DEFAULT 0
	CHECK (members_can_create_packages IN (0, 1));
ALTER TABLE orgs ADD COLUMN members_can_create_credentials INTEGER NOT NULL DEFAULT 1
	CHECK (members_can_create_credentials IN (0, 1));
