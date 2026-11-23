-- Referral rewards credit an organization: a personal link credits the
-- referrer's personal org, an org link credits that org. The referrer column
-- becomes the credited org id (`referrer_org_id`); existing rows point at the
-- referrer's personal org. SQLite cannot rename/retype NOT NULL columns in
-- place, so the table is rebuilt with the same rows.
CREATE TABLE referrals_next (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	referrer_org_id TEXT NOT NULL,
	referee_stable_user_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'rewarded', 'rejected')),
	rewarded_at TEXT,
	reward_invoice_id TEXT,
	reject_reason TEXT,
	held_invoice_id TEXT,
	held_period_end_at TEXT,
	credits_granted_at TEXT
);

INSERT INTO referrals_next (
	id, referrer_org_id, referee_stable_user_id, created_at, status,
	rewarded_at, reward_invoice_id, reject_reason, held_invoice_id,
	held_period_end_at, credits_granted_at
)
SELECT
	r.id,
	COALESCE(
		(
			SELECT NULLIF(TRIM(u.personal_org_id), '')
			FROM users u
			WHERE u.stable_user_id = r.referrer_stable_user_id
		),
		r.referrer_stable_user_id
	),
	r.referee_stable_user_id, r.created_at, r.status, r.rewarded_at,
	r.reward_invoice_id, r.reject_reason, r.held_invoice_id,
	r.held_period_end_at, r.credits_granted_at
FROM referrals r;

DROP TABLE referrals;

ALTER TABLE referrals_next RENAME TO referrals;

CREATE UNIQUE INDEX idx_referrals_referee
	ON referrals(referee_stable_user_id);

CREATE INDEX idx_referrals_referrer_org
	ON referrals(referrer_org_id);

CREATE UNIQUE INDEX idx_referrals_reward_invoice
	ON referrals(reward_invoice_id)
	WHERE reward_invoice_id IS NOT NULL;
