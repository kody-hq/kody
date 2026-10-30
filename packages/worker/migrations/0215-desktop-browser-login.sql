CREATE TABLE desktop_login_grants (
 code_hash TEXT PRIMARY KEY,
 challenge TEXT NOT NULL,
 person_id TEXT NOT NULL,
 session_issued_at INTEGER NOT NULL,
 session_expires_at INTEGER NOT NULL,
 remember_me INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX desktop_login_grants_expiry ON desktop_login_grants(expires_at);
