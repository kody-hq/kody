-- Claimable guest accounts (ADR 0091 amendment). A guest is a person created
-- from the OAuth authorize screen's Try it out choice. guest_expires_at is the
-- end of full access; NULL means a regular account. The account stays
-- read-only for seven days after that and is then deleted.
ALTER TABLE users ADD COLUMN guest_expires_at TEXT;

-- One row per guest. claim_code is the /claim/<code> link secret. After a
-- claim into an existing account the guest users row is deleted and this
-- row stays as the alias that keeps the guest's OAuth grants working for
-- the claiming person (claimed_into_person_id / claimed_into_org_id).
CREATE TABLE guest_accounts (
	person_id TEXT PRIMARY KEY,
	personal_org_id TEXT NOT NULL,
	claim_code TEXT NOT NULL UNIQUE,
	client_name TEXT,
	guest_slug TEXT,
	expires_at TEXT NOT NULL,
	delete_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	claimed_at TEXT,
	claimed_into_person_id TEXT,
	claimed_into_org_id TEXT
);
CREATE INDEX guest_accounts_delete_at ON guest_accounts (delete_at)
	WHERE claimed_at IS NULL;
CREATE INDEX guest_accounts_claimed_into ON guest_accounts (claimed_into_person_id)
	WHERE claimed_into_person_id IS NOT NULL;

-- Agent-led claim: a one-time code emailed to the person. mode 'new' converts
-- the guest in place with username; mode 'merge' moves it into the account
-- that owns email.
CREATE TABLE guest_claim_codes (
	person_id TEXT PRIMARY KEY,
	email TEXT NOT NULL,
	username TEXT,
	mode TEXT NOT NULL CHECK (mode IN ('new', 'merge')),
	code_hash TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL
);
