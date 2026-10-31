-- Profiles P9 follow-up: drop the retired connection-profiles table (ADR 0092).
-- The previous deploy removed its last runtime references (account deletion,
-- org soft-delete and restore, org transfer), so the live Worker no longer
-- touches it while this migration runs.
DROP INDEX IF EXISTS idx_connection_profiles_user_name;
DROP INDEX IF EXISTS idx_connection_profiles_user_id;
DROP INDEX IF EXISTS connection_profiles_org_name_idx;
DROP TABLE IF EXISTS connection_profiles;
