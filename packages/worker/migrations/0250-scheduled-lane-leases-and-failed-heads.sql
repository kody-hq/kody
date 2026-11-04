-- Single-flight lease per scheduled lane: a tick runs only while it holds the
-- row, and a tick that finds an unexpired lease skips. The lease expires on
-- its own a little past the lane budget, so a consumer killed mid-tick cannot
-- wedge the lane.
CREATE TABLE scheduled_lane_leases (
	lane TEXT PRIMARY KEY,
	holder TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

-- The last external HEAD whose publish checks failed during reconcile, so the
-- lane does not re-clone and re-check the same commit every tick. A new HEAD
-- or an elapsed retry window runs the checks again.
ALTER TABLE entity_sources ADD COLUMN external_check_failed_commit TEXT;
ALTER TABLE entity_sources ADD COLUMN external_check_failed_at TEXT;
