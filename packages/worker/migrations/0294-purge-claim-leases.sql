-- Purge-lane claims: a renewable lease while a pass works an item, a failure
-- fence plus attempt counter, and a block once an item keeps failing.
ALTER TABLE users ADD COLUMN purge_claim_holder TEXT;
ALTER TABLE users ADD COLUMN purge_claim_until TEXT;
ALTER TABLE users ADD COLUMN purge_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN purge_blocked_at TEXT;

ALTER TABLE orgs ADD COLUMN purge_claim_holder TEXT;
ALTER TABLE orgs ADD COLUMN purge_claim_until TEXT;
ALTER TABLE orgs ADD COLUMN purge_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orgs ADD COLUMN purge_blocked_at TEXT;
