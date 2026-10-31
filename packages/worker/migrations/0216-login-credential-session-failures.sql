-- A login credential's last failed exchange, per revision (ADR 0090):
-- callers fail fast while `retry_after` is in the future, and
-- `needs_reconnect` holds until a new revision (a saved value) replaces it.
ALTER TABLE login_credential_sessions ADD COLUMN failure_revision TEXT;
ALTER TABLE login_credential_sessions ADD COLUMN failure_kind TEXT;
ALTER TABLE login_credential_sessions ADD COLUMN failure_count INTEGER;
ALTER TABLE login_credential_sessions ADD COLUMN retry_after INTEGER;
