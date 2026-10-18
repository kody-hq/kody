/** Max platform feedback submissions per account in a rolling 24-hour window. */
export const platformFeedbackSubmissionRateLimit = 20

/** Rolling window length for `platformFeedbackSubmissionRateLimit`. */
export const platformFeedbackSubmissionRateLimitWindowSeconds = 24 * 60 * 60

export const platformFeedbackSubmissionRateLimitWindowMs =
	platformFeedbackSubmissionRateLimitWindowSeconds * 1_000

/** Max open or triaged platform feedback submissions per account. */
export const platformFeedbackActiveQueueLimit = 100
