-- Admin hard-delete of a person account is a two-step approval.
-- `adminUserAccountDelete` inserts one row and returns the page URL.
-- Approving on that page is what deletes the account. The row is claimed
-- when deletion starts and cleared again if deletion stops partway so the
-- same link can be retried.

CREATE TABLE admin_account_deletion_approvals (
	id TEXT PRIMARY KEY NOT NULL,
	target_stable_user_id TEXT NOT NULL,
	requested_by_stable_user_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	consumed_at TEXT
);

CREATE INDEX admin_account_deletion_approvals_target_idx
	ON admin_account_deletion_approvals (target_stable_user_id, consumed_at);
