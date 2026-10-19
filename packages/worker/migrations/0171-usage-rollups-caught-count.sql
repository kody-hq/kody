-- Caught package_static_call throws (handled by a successful run) stay
-- visible beside real failures. Fleet error-rate alerting still counts
-- only error_count / AE blob4 = 'error'. Historical rows default to 0.

ALTER TABLE usage_rollups ADD COLUMN caught_count INTEGER NOT NULL DEFAULT 0;
