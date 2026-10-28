-- One in-flight community fork per (target owner, listing). A fork request
-- claims this row before it checks for an existing fork and releases it when
-- the fork row is written (or the fork fails). A second request for the same
-- owner and listing waits for the claim instead of creating a duplicate fork.
-- Claims carry a lease so a crashed request cannot block forks forever. A
-- claim is a short-lived lock, not account data: it holds no user content and
-- is deleted when the fork finishes.
CREATE TABLE community_fork_claims (
	owner_id TEXT NOT NULL,
	listing_id TEXT NOT NULL,
	claim_id TEXT NOT NULL,
	requested_kody_id TEXT,
	started_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	PRIMARY KEY (owner_id, listing_id)
);
