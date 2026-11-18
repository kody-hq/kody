-- Second-agent gift for accounts already on paid Kody Pro (or retired
-- Standard): instead of the Free overlay, Stripe credits the invoice balance
-- with 14 days of the subscription price. requested_at marks the pending
-- credit; credit_id is the Stripe customer balance transaction once applied.
ALTER TABLE orgs ADD COLUMN second_agent_gift_invoice_credit_requested_at TEXT;
ALTER TABLE orgs ADD COLUMN second_agent_gift_invoice_credit_id TEXT;

-- One-time backfill: paid accounts that earned the gift before this change got
-- a ledger row with no expiry and nothing else. Queue their credit. The
-- excluded org was already credited by hand.
UPDATE orgs
SET second_agent_gift_invoice_credit_requested_at = second_agent_standard_gift_granted_at
WHERE second_agent_standard_gift_granted_at IS NOT NULL
  AND second_agent_standard_gift_expires_at IS NULL
  AND stripe_customer_id IS NOT NULL
  AND stripe_plan IS NOT NULL
  AND deleted_at IS NULL
  AND id <> '0da6adecc07a6bbc20505c5d9485669506a1ef00d1712795b432c6e4d662d654';
