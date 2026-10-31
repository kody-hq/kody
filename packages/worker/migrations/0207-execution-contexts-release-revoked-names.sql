-- Revoking an execution context releases its name (2026-10-30). Name lookups
-- already skip revoked contexts and run records keep their own copy of the
-- name, so only live contexts need unique names in an org.
DROP INDEX execution_contexts_org_name;
CREATE UNIQUE INDEX execution_contexts_org_name ON execution_contexts (org_id, name)
	WHERE revoked_at IS NULL;
