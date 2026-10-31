-- Profiles P4 to P6 (ADR 0092, 2026-10-31). `api_tokens.profile_id` binds a
-- token to one profile by id; NULL is the live mirror (the person's own
-- access). `enablements.enabler_profile_id` records the profile of the
-- credential that turned a trigger on, so its runs stay narrowed to that
-- profile chain and pause when the chain goes inactive.
-- `mcp_event_subscriptions.profile_id` keeps a subscriber's profile so fan-out
-- checks the profile chain, not the person; `follows.creator_profile_id` does
-- the same for follow delivery. Existing rows stay NULL.
ALTER TABLE api_tokens ADD COLUMN profile_id TEXT;
ALTER TABLE enablements ADD COLUMN enabler_profile_id TEXT;
CREATE INDEX IF NOT EXISTS api_tokens_profile_id_idx ON api_tokens (profile_id) WHERE profile_id IS NOT NULL;
ALTER TABLE mcp_event_subscriptions ADD COLUMN profile_id TEXT;
ALTER TABLE follows ADD COLUMN creator_profile_id TEXT;
