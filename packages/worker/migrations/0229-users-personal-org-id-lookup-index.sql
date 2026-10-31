-- Owner-id lookups resolve a person by `stable_user_id = ? OR personal_org_id = ?`.
-- `idx_users_personal_org_id` is partial (WHERE deleted_at IS NULL), and SQLite
-- cannot use a partial index for one term of an OR, so those lookups scanned
-- every user row. A plain index lets the planner use MULTI-INDEX OR.
CREATE INDEX IF NOT EXISTS idx_users_personal_org_id_lookup
	ON users(personal_org_id);
