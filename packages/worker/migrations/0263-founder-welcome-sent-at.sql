-- Durable once-per-user claim for the founder welcome email. Stamped when the
-- send is claimed (cleared if the send fails), so a lost KV claim or a retried
-- verification can never resend it. Existing rows stay NULL and are never
-- backfilled: only a new verification triggers the send.
ALTER TABLE users ADD COLUMN founder_welcome_sent_at TEXT;
