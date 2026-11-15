-- The persisted artifact manifest was removed in #5214, and nothing has read or
-- written published_bundle_artifacts.total_bytes since. Dropping the column
-- also clears the values left on rows written in November 2026 (#5210).
ALTER TABLE published_bundle_artifacts DROP COLUMN total_bytes;
