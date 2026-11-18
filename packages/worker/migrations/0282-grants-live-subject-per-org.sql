-- A live grant is unique per org. A resource one org owns and another org
-- attaches (an execution context and its machine capabilities) takes a grant
-- for the same person in each org, and each org's grant is its own.
DROP INDEX grants_live_subject;

CREATE UNIQUE INDEX grants_live_subject ON grants (
	org_id,
	resource_type,
	resource_id,
	subject_type,
	subject_id
) WHERE deleted_at IS NULL;
