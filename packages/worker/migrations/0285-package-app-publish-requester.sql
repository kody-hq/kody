-- A publish that outlives the request finishes in a durable workflow that
-- acts as the owning org, not as a person. The request notes who asked for
-- which commit here, so the finish step can record that person as publisher
-- once the commit is actually published (#5315).
ALTER TABLE package_app_authority ADD COLUMN publish_requested_by_person_id TEXT;
ALTER TABLE package_app_authority ADD COLUMN publish_requested_commit TEXT;
