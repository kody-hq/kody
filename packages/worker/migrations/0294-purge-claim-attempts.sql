-- Purge lanes lease claimed rows with purge_fence_until (a 15 minute lease,
-- or a 24 hour fence after a failure), count failed attempts, and stop
-- claiming a row once purge_blocked_at is set after the fifth failure.
ALTER TABLE users ADD COLUMN purge_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN purge_fence_until TEXT;
ALTER TABLE users ADD COLUMN purge_blocked_at TEXT;
ALTER TABLE orgs ADD COLUMN purge_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orgs ADD COLUMN purge_fence_until TEXT;
ALTER TABLE orgs ADD COLUMN purge_blocked_at TEXT;
