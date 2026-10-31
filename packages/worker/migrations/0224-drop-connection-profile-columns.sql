-- Profiles P9: drop the columns of the retired connection-profile system
-- (ADR 0092). The Worker stopped reading and writing them in the previous
-- deploy, so dropping them here cannot break the version still serving while
-- this migration runs. `connection_profiles` itself is still listed by the
-- running Worker's deletion and soft-delete targets, so its DROP TABLE waits
-- for the next deploy.
ALTER TABLE api_tokens DROP COLUMN profile_name;
ALTER TABLE mcp_event_subscriptions DROP COLUMN connection_profile_name;
ALTER TABLE enablements DROP COLUMN enabler_profile_name;
