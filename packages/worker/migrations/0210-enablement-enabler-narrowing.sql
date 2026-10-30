-- What the enabler's credential could do when they turned a trigger on
-- (2026-10-30). A triggered run acts as the enabler but never with more than
-- that credential: `enabler_scopes_json` is the token's scope list (NULL did
-- not narrow), `enabler_profile_name` its connection profile. Existing rows
-- were turned on before this was recorded and stay unnarrowed.
ALTER TABLE enablements ADD COLUMN enabler_scopes_json TEXT;
ALTER TABLE enablements ADD COLUMN enabler_profile_name TEXT;
