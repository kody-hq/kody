-- Watermark for consecutive-failure counting: last delivered event that
-- reset the counter. Terminal increments only apply when the provider
-- event is strictly newer than this watermark, so a concurrent older
-- bounce cannot re-increment after a delivered reset.

ALTER TABLE orgs ADD COLUMN email_outbound_failure_watermark_at TEXT;
