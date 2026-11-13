-- Guest claim links stop storing the /claim/<code> secret in plaintext.
-- claim_code now holds the SHA-256 lookup hash of the code (64 hex chars,
-- never the 24-char code shape). claim_code_encrypted holds the code sealed
-- with SECRET_STORE_KEY (AAD bound to person_id) so the guest can be shown
-- their own claim link again. Existing rows are converted by the guest claim
-- code backfill; until then lookups also match the legacy plaintext value.
ALTER TABLE guest_accounts ADD COLUMN claim_code_encrypted TEXT;
