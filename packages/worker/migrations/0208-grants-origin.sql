-- Where a grant came from (2026-10-30). `created` grants are written for the
-- person who created a resource; org transfer re-points or drops them instead
-- of refusing. Every existing grant was made by hand.
ALTER TABLE grants ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
	CHECK (origin IN ('manual', 'created'));
