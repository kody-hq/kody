-- Retention purge claims. `purge_lease_expires_at` is the claim's lease
-- (renewed after each completed step) or, after a failed attempt, its retry
-- fence. `purge_failed_attempts` counts failed attempts; at 5 the row is
-- blocked from every purge lane. Deleting the row clears both.
ALTER TABLE users ADD COLUMN purge_lease_expires_at TEXT;
ALTER TABLE users ADD COLUMN purge_failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orgs ADD COLUMN purge_lease_expires_at TEXT;
ALTER TABLE orgs ADD COLUMN purge_failed_attempts INTEGER NOT NULL DEFAULT 0;
