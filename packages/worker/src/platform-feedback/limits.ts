/** Max platform feedback submissions per account in a rolling 24-hour window. */
export const platformFeedbackSubmissionRateLimit = 20

/** Rolling window length for `platformFeedbackSubmissionRateLimit`. */
export const platformFeedbackSubmissionRateLimitWindowSeconds = 24 * 60 * 60

export const platformFeedbackSubmissionRateLimitWindowMs =
	platformFeedbackSubmissionRateLimitWindowSeconds * 1_000

/** Max open or triaged platform feedback submissions per account. */
export const platformFeedbackActiveQueueLimit = 100

/** Max characters for submitter-visible resolution notes (and admin user_message). */
export const platformFeedbackResolutionNoteMaxLength = 2_000

/** Max https PR URLs stored on one resolved/dismissed feedback record. */
export const platformFeedbackResolutionPrUrlMaxCount = 5

/** Max characters per resolution PR URL. */
export const platformFeedbackResolutionPrUrlMaxLength = 2_048

/**
 * Max stored JSON length for `resolution_pr_urls` (count × max length plus
 * array/quote overhead). Keeps the D1 CHECK aligned with application limits.
 */
export const platformFeedbackResolutionPrUrlsJsonMaxLength =
	platformFeedbackResolutionPrUrlMaxCount *
		(platformFeedbackResolutionPrUrlMaxLength + 3) +
	2
