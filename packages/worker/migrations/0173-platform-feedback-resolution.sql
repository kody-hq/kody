-- Submitter-visible outcome fields for platform feedback.
-- Additive only: existing rows stay NULL with no backfill.
-- Separate from internal-only admin_note (never shown to submitters).

ALTER TABLE platform_feedback ADD COLUMN resolution_note TEXT
	CHECK (
		resolution_note IS NULL OR length(resolution_note) <= 2000
	);

-- JSON array of https PR URLs (validated in application code).
ALTER TABLE platform_feedback ADD COLUMN resolution_pr_urls TEXT
	CHECK (
		resolution_pr_urls IS NULL OR length(resolution_pr_urls) <= 12000
	);
