-- Email lookups (billing customer linking, admin credit grants) match on
-- lower(email); a plain users(email) index cannot serve that expression.
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email));
