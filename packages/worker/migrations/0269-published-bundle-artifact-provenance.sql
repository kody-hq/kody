-- Informational provenance of each stored bundle artifact: where it was built
-- (cloud, cli, context), the execution context name for a context build, and
-- a SHA-256 of its stored modules. NULL marks a row written before these were
-- recorded. Nothing reads them to allow or refuse a publish or a listing.
ALTER TABLE published_bundle_artifacts ADD COLUMN built_in TEXT;
ALTER TABLE published_bundle_artifacts ADD COLUMN built_context_name TEXT;
ALTER TABLE published_bundle_artifacts ADD COLUMN bundle_sha256 TEXT;
