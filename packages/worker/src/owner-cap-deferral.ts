const deferralBaseSeconds = 5
const deferralMaxSeconds = 300

/**
 * How long a queued item waits before the consumer looks at it again after
 * its owner was at the in-flight limit. Doubles per deferral, with jitter so
 * one owner's backlog does not come back all at once.
 */
export function ownerCapDeferralDelaySeconds(
	deferrals: number,
	random: () => number = Math.random,
) {
	const base = Math.min(
		deferralMaxSeconds,
		deferralBaseSeconds * 2 ** Math.min(deferrals, 10),
	)
	return Math.ceil(base / 2 + random() * (base / 2))
}
