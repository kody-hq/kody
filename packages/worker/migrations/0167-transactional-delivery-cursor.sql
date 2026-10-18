-- Latest provider status for one transactional send. Password-reset mail
-- does not write users.email_verification_delivery_*, so a late bounce
-- after delivered would otherwise re-suppress the recipient. Nullable:
-- rows created before this column have no cursor yet.
ALTER TABLE transactional_email_delivery_index ADD COLUMN last_status TEXT;
ALTER TABLE transactional_email_delivery_index ADD COLUMN last_status_at TEXT;
