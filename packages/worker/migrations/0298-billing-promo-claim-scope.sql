-- A promotion code can opt into a narrower claim scope (`kody_claim_scope`
-- metadata). Claims are keyed per person and claim key: `lifetime` (the
-- one-claim-ever rule, every existing row) or `campaign:<id>`. SQLite cannot
-- change a primary key in place, so the table is rebuilt with the same rows.
CREATE TABLE billing_promo_claims_next (
	user_id TEXT NOT NULL,
	claim_key TEXT NOT NULL DEFAULT 'lifetime',
	promotion_code_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('reserved', 'claimed')),
	checkout_session_id TEXT,
	reserved_at TEXT NOT NULL,
	claimed_at TEXT,
	PRIMARY KEY (user_id, claim_key)
);

INSERT INTO billing_promo_claims_next (
	user_id, claim_key, promotion_code_id, org_id, status,
	checkout_session_id, reserved_at, claimed_at
)
SELECT
	user_id, 'lifetime', promotion_code_id, org_id, status,
	checkout_session_id, reserved_at, claimed_at
FROM billing_promo_claims;

DROP TABLE billing_promo_claims;

ALTER TABLE billing_promo_claims_next RENAME TO billing_promo_claims;

CREATE INDEX idx_billing_promo_claims_session
	ON billing_promo_claims (checkout_session_id);
