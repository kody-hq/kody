-- Per-credential fill placement (where placeholders may be filled). Null means
-- anywhere — today's behavior — so existing credentials are unchanged. The
-- gateway does not enforce this column yet; read/write and audit land first.
--
-- placement_json is null or a JSON object with at least one of:
--   "headers": true | ["Authorization", ...]
--   "query": true
--   "path": true
--   "body": true
-- Named headers, when listed, limit which header names may receive a fill.
-- Distinct from inject_json, which only steers the scoped credential() client.

ALTER TABLE secret_entries ADD COLUMN placement_json TEXT
	CHECK (placement_json IS NULL OR json_valid(placement_json));

ALTER TABLE user_integrations ADD COLUMN placement_json TEXT
	CHECK (placement_json IS NULL OR json_valid(placement_json));

ALTER TABLE secret_provider_bindings ADD COLUMN placement_json TEXT
	CHECK (placement_json IS NULL OR json_valid(placement_json));
