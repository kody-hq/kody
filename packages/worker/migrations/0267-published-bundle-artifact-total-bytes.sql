-- Stored module bytes of each published bundle artifact, written with the
-- artifact's manifest. NULL marks a row whose stored artifact predates the
-- manifest; counting NULLs is how manifest coverage is measured.
ALTER TABLE published_bundle_artifacts ADD COLUMN total_bytes INTEGER;
