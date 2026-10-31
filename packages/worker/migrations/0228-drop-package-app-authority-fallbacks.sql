-- The visitor-authority fallback soak is over. Apps run only as their
-- runs-as person; leftover would-break rows are no longer read.
DROP INDEX IF EXISTS package_app_authority_fallbacks_package_idx;
DROP TABLE IF EXISTS package_app_authority_fallbacks;
