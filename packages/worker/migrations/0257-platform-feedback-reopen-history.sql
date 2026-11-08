-- Internal audit trail of admin reopens (resolved/dismissed -> triaged).
-- Additive only: existing rows stay NULL with no backfill. JSON array of
-- { from_status, to_status, note, actor_user_id, recorded_at }, capped in
-- application code (reopens past the cap are refused, never dropped).

ALTER TABLE platform_feedback ADD COLUMN reopen_history TEXT
	CHECK (
		reopen_history IS NULL OR length(reopen_history) <= 200000
	);
