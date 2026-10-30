-- Execution context grants no longer carry a credential mode (ADR 0083
-- amendment 2026-10-30): runs use the requester's credentials as in Kody cloud.
UPDATE execution_contexts
SET grant_json = json_remove(grant_json, '$.credentials')
WHERE json_type(grant_json, '$.credentials') IS NOT NULL;
