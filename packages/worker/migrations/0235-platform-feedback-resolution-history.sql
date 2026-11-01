-- Superseded submitter-visible outcomes for platform feedback (follow-ups).
-- Additive only: existing rows stay NULL with no backfill. JSON array of
-- { note, pr_urls, recorded_at }, capped in application code.

ALTER TABLE platform_feedback ADD COLUMN resolution_history TEXT
	CHECK (
		resolution_history IS NULL OR length(resolution_history) <= 200000
	);
