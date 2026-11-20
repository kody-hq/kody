-- Purge lane claims: a renewable lease (`purge_lease_until`) and a failed
-- attempt counter. Rows that reach the attempt limit are blocked: no purge
-- lane claims them again.
ALTER TABLE users ADD COLUMN purge_lease_until TEXT;
ALTER TABLE users ADD COLUMN purge_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orgs ADD COLUMN purge_lease_until TEXT;
ALTER TABLE orgs ADD COLUMN purge_attempts INTEGER NOT NULL DEFAULT 0;
