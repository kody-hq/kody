-- Built-in Admin org role: every Owner permission except org:delete and
-- changes to Owners (enforced in the membership writes).
--
-- SQLite cannot relax the `role` CHECK in place, so org_memberships is
-- rebuilt with the same columns in the same order and 'admin' added to the
-- CHECK. No table references org_memberships and it has no triggers; its one
-- index is recreated.

CREATE TABLE org_memberships_0261 (
	org_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'billing')),
	invited_by_user_id TEXT,
	created_at TEXT NOT NULL,
	deleted_at TEXT,
	PRIMARY KEY (org_id, user_id)
);

INSERT INTO org_memberships_0261 (
	org_id,
	user_id,
	role,
	invited_by_user_id,
	created_at,
	deleted_at
)
SELECT org_id, user_id, role, invited_by_user_id, created_at, deleted_at
FROM org_memberships;

DROP TABLE org_memberships;
ALTER TABLE org_memberships_0261 RENAME TO org_memberships;

CREATE INDEX IF NOT EXISTS org_memberships_user_idx
	ON org_memberships (user_id);
