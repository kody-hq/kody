-- Owner-private codemod detail per run item (for example the capability names
-- 0018 would add to an app's manifest). Admin-only: step results and findings
-- never include it, so a later owner notice can show each owner their own list.
ALTER TABLE package_codemod_run_items ADD COLUMN owner_detail_json TEXT;
