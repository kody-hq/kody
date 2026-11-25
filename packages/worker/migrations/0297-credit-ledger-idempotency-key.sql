-- Caller-chosen idempotency key for admin credit grants
-- (`adminOrgCreditGrant` idempotencyKey). A retry with the same key returns
-- the original ledger entry instead of granting again. Keys are global, so a
-- key reused for a different organization or amount is refused.
ALTER TABLE credit_ledger_entries ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX idx_credit_ledger_entries_idempotency_key
	ON credit_ledger_entries (idempotency_key)
	WHERE idempotency_key IS NOT NULL;
