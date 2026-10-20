/**
 * Mirrors the `platform_feedback` schema in
 * `packages/worker/migrations/0001-squashed-init.sql` for `*.node.test.ts`
 * suites that build their sqlite fixture by hand.
 */
export const platformFeedbackTestSchemaSql = `
CREATE TABLE IF NOT EXISTS "platform_feedback" (
	id TEXT PRIMARY KEY NOT NULL,
	submitter_user_id TEXT NOT NULL,
	category TEXT NOT NULL CHECK (
		category IN ('friction', 'bug', 'experience', 'suggestion', 'cancellation', 'other')
	),
	summary TEXT NOT NULL CHECK (
		length(summary) BETWEEN 1 AND 200
	),
	details TEXT NOT NULL CHECK (
		length(details) BETWEEN 1 AND 8000
	),
	status TEXT NOT NULL DEFAULT 'open' CHECK (
		status IN ('open', 'triaged', 'resolved', 'dismissed')
	),
	reviewed_by_user_id TEXT,
	reviewed_at TEXT,
	admin_note TEXT CHECK (
		admin_note IS NULL OR length(admin_note) <= 2000
	),
	resolution_note TEXT CHECK (
		resolution_note IS NULL OR length(resolution_note) <= 2000
	),
	resolution_pr_urls TEXT CHECK (
		resolution_pr_urls IS NULL OR length(resolution_pr_urls) <= 12000
	),
	revision INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	submitter_username TEXT NOT NULL,
	submitter_email TEXT NOT NULL
);
CREATE INDEX idx_platform_feedback_created_at_id
ON platform_feedback(created_at DESC, id DESC);
CREATE INDEX idx_platform_feedback_status_created_at_id
ON platform_feedback(status, created_at DESC, id DESC);
CREATE INDEX idx_platform_feedback_category_created_at_id
ON platform_feedback(category, created_at DESC, id DESC);
CREATE INDEX idx_platform_feedback_reviewer
ON platform_feedback(reviewed_by_user_id);
CREATE INDEX idx_platform_feedback_submitter_status
ON platform_feedback(submitter_user_id, status);
CREATE INDEX idx_platform_feedback_submitter_created_at
ON platform_feedback(submitter_user_id, created_at);
CREATE INDEX idx_platform_feedback_terminal_updated_at_id
ON platform_feedback(updated_at, id)
WHERE status IN ('resolved', 'dismissed');
`
