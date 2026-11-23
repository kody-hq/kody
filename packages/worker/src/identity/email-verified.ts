import { latestReferrerPaidPeriodEnd } from '#worker/billing/referrer-paid-period.ts'
import { maybeRewardHeldReferralAfterEmailVerified } from '#worker/entitlements/referral-program.ts'

/**
 * The step every `users.email_verified_at` write runs once it commits (email
 * link, social sign-in, email change, guest claim, admin). It grants referral
 * rewards held on this person's verification, whether they are the referee,
 * the personal referrer, or an owner of the referrer team org. Repeats and
 * concurrent calls are safe: the grant is guarded in SQL and lands once.
 * `email-verified.node.test.ts` fails when a new writer skips this step.
 */
export async function onEmailVerified(input: {
	env: Env
	stableUserId: string
}) {
	try {
		await maybeRewardHeldReferralAfterEmailVerified({
			db: input.env.APP_DB,
			stableUserId: input.stableUserId,
			resolveReferrerPaidPeriodEnd: (referrerOrgId) =>
				latestReferrerPaidPeriodEnd({ env: input.env, referrerOrgId }),
		})
	} catch (error) {
		// Verification still succeeds; the held credits stay ungranted until the
		// next verification or the referee's next paid invoice retries them.
		console.warn('referral-held-reward-failed', error)
	}
}
