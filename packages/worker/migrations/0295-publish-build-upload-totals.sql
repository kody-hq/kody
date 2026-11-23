-- Running chunk count and byte total per publish build, reserved atomically
-- by each chunk PUT so concurrent uploads cannot pass the per-build limits.
ALTER TABLE publish_builds ADD COLUMN uploaded_chunks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publish_builds ADD COLUMN uploaded_bytes INTEGER NOT NULL DEFAULT 0;
